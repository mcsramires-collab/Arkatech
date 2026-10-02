import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dbStore } from './dbStore';
import { Averbacao, Policy, Tenant } from '../types';

export type InsurerDispatchStatus =
  | 'PENDING'
  | 'SENDING'
  | 'RETRY'
  | 'BLOCKED_CONFIG'
  | 'CONFIRMED'
  | 'FAILED_FINAL';

export interface InsurerDispatch {
  id: string;
  averbacao_id: string;
  insurer_id: string;
  policy_id: string;
  tenant_id: string;
  status: InsurerDispatchStatus;
  idempotency_key: string;
  attempt_count: number;
  next_attempt_at?: string;
  last_attempt_at?: string;
  last_http_status?: number;
  last_error?: string;
  external_reference?: string;
  external_number?: string;
  confirmed_at?: string;
  created_at: string;
  updated_at: string;
}

interface AdapterResponse {
  status?: string;
  accepted?: boolean;
  codigo?: string;
  mensagem?: string;
  numero_averbacao?: string;
  protocolo?: string;
  external_reference?: string;
  retryable?: boolean;
}

const MAX_ATTEMPTS = Math.max(1, Number(process.env.INSURER_DISPATCH_MAX_ATTEMPTS || 8));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.INSURER_DISPATCH_TIMEOUT_MS || 15000));
const processingIds = new Set<string>();

function outboxPath(): string {
  return path.join(
    process.env.DATA_DIR || path.join(__dirname, '../../'),
    'insurer_dispatch_outbox.json'
  );
}

function readOutbox(): InsurerDispatch[] {
  const file = outboxPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[insurer-dispatch] Falha ao ler outbox.', error);
    return [];
  }
}

function writeOutbox(items: InsurerDispatch[]): void {
  const file = outboxPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * Persiste somente o registro alterado sobre a versão MAIS RECENTE do arquivo. O processador
 * externo contém awaits de rede; durante esse intervalo outra requisição pode enfileirar uma
 * averbação nova. Regravar o snapshot capturado antes do await apagaria esse novo registro.
 */
function persistDispatch(record: InsurerDispatch): void {
  const latest = readOutbox();
  const index = latest.findIndex((item) => item.id === record.id);
  if (index >= 0) latest[index] = { ...record };
  else latest.unshift({ ...record });
  writeOutbox(latest);
}

function envSuffix(insurerId: string): string {
  return insurerId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function adapterConfig(insurerId: string): { url?: string; token?: string } {
  const suffix = envSuffix(insurerId);
  return {
    url: process.env[`INSURER_ADAPTER_URL_${suffix}`] || process.env.INSURER_ADAPTER_URL,
    token: process.env[`INSURER_ADAPTER_TOKEN_${suffix}`] || process.env.INSURER_ADAPTER_TOKEN
  };
}

function retryAt(attemptCount: number): string {
  const seconds = Math.min(15 * 60, 30 * Math.pow(2, Math.max(0, attemptCount - 1)));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function parseJsonSafe(text: string): AdapterResponse {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function isRejectedBody(body: AdapterResponse): boolean {
  if (body.accepted === false) return true;
  const status = String(body.status || '').trim().toLowerCase();
  return ['erro', 'error', 'rejected', 'recusado', 'denied', 'negado'].includes(status);
}

function markFiscalDocument(
  averbacaoId: string,
  status: 'AVERBADO' | 'RECUSADO' | 'PENDENTE',
  codigo: string,
  mensagem: string
): void {
  for (const document of dbStore.fiscalDocuments) {
    if (!document.averbacao_ids.includes(averbacaoId)) continue;
    document.status = status;
    document.codigo_resultado = codigo;
    document.mensagem_resultado = mensagem;
    document.processed_at = new Date().toISOString();
  }
}

function buildPayload(
  dispatch: InsurerDispatch,
  averbacao: Averbacao,
  policy: Policy,
  tenant: Tenant,
  rawXml: string
) {
  return {
    schema_version: '1.0',
    dispatch_id: dispatch.id,
    idempotency_key: dispatch.idempotency_key,
    tenant: {
      id: tenant.id,
      cnpj: tenant.cnpj,
      razao_social: tenant.razao_social
    },
    policy: {
      id: policy.id,
      numero_apolice: policy.numero_apolice,
      ramo: policy.ramo,
      codigo_interno_seguradora: policy.codigo_interno_seguradora
    },
    averbacao: {
      id: averbacao.id,
      protocolo_interno: averbacao.protocolo_interno_averbacao,
      tipo_documento: averbacao.tipo_documento,
      chave_documento: averbacao.chave_documento,
      numero_documento: averbacao.numero_documento,
      serie_documento: averbacao.serie_documento,
      cnpj_emissor: averbacao.cnpj_emissor,
      cnpj_remetente: averbacao.cnpj_remetente,
      cnpj_destinatario: averbacao.cnpj_destinatario,
      cnpj_tomador: averbacao.cnpj_tomador,
      protocolo_aceitacao_sefaz: averbacao.protocolo_aceitacao_sefaz,
      valor_carga: averbacao.valor_carga,
      valor_considerado_averbacao: averbacao.valor_considerado_averbacao,
      lmi_no_momento_envio: averbacao.lmi_no_momento_envio,
      sublimite_no_momento_envio: averbacao.sublimite_no_momento_envio
    },
    raw_xml: rawXml
  };
}

export class InsurerDispatchService {
  static enqueue(params: {
    averbacao: Averbacao;
    policy: Policy;
    tenant: Tenant;
  }): InsurerDispatch {
    const outbox = readOutbox();
    const existing = outbox.find((item) => item.averbacao_id === params.averbacao.id);
    if (existing) return existing;

    const now = new Date().toISOString();
    const config = adapterConfig(params.policy.insurer_id);
    const blocked = !config.url || !config.token;
    const id = crypto.randomUUID();
    const record: InsurerDispatch = {
      id,
      averbacao_id: params.averbacao.id,
      insurer_id: params.policy.insurer_id,
      policy_id: params.policy.id,
      tenant_id: params.tenant.id,
      status: blocked ? 'BLOCKED_CONFIG' : 'PENDING',
      idempotency_key: crypto
        .createHash('sha256')
        .update(`${params.policy.insurer_id}:${params.averbacao.id}`)
        .digest('hex'),
      attempt_count: 0,
      next_attempt_at: blocked ? undefined : now,
      last_error: blocked
        ? `Adapter não configurado. Defina INSURER_ADAPTER_URL_${envSuffix(params.policy.insurer_id)} e INSURER_ADAPTER_TOKEN_${envSuffix(params.policy.insurer_id)}.`
        : undefined,
      created_at: now,
      updated_at: now
    };
    outbox.unshift(record);
    writeOutbox(outbox);
    return record;
  }

  static list(status?: InsurerDispatchStatus): InsurerDispatch[] {
    const items = readOutbox();
    return status ? items.filter((item) => item.status === status) : items;
  }

  static retry(id: string): InsurerDispatch | undefined {
    const outbox = readOutbox();
    const item = outbox.find((entry) => entry.id === id);
    if (!item) return undefined;
    const config = adapterConfig(item.insurer_id);
    item.status = config.url && config.token ? 'PENDING' : 'BLOCKED_CONFIG';
    item.next_attempt_at = item.status === 'PENDING' ? new Date().toISOString() : undefined;
    item.last_error = item.status === 'BLOCKED_CONFIG' ? 'Adapter da seguradora ainda não configurado.' : undefined;
    item.updated_at = new Date().toISOString();
    writeOutbox(outbox);
    return item;
  }

  static async processDue(limit = 20): Promise<{
    processed: number;
    confirmed: number;
    retried: number;
    failed: number;
    blocked: number;
  }> {
    const snapshot = readOutbox();
    const nowMs = Date.now();
    // Um processo pode cair depois de gravar SENDING e antes do ACK. Após um lease conservador,
    // essa entrada volta a ser elegível com a MESMA idempotency key, evitando fila presa.
    const staleSendingCutoff = nowMs - Math.max(60_000, REQUEST_TIMEOUT_MS * 2);
    const due = snapshot
      .filter((item) => {
        if (processingIds.has(item.id)) return false;
        const normalDue =
          (item.status === 'PENDING' || item.status === 'RETRY' || item.status === 'BLOCKED_CONFIG') &&
          (!item.next_attempt_at || new Date(item.next_attempt_at).getTime() <= nowMs);
        const staleSending =
          item.status === 'SENDING' &&
          Boolean(item.last_attempt_at) &&
          new Date(item.last_attempt_at!).getTime() <= staleSendingCutoff;
        return normalDue || staleSending;
      })
      .slice(0, Math.max(1, Math.min(limit, 100)));

    let confirmed = 0;
    let retried = 0;
    let failed = 0;
    let blocked = 0;

    for (const item of due) {
      processingIds.add(item.id);
      try {
        const config = adapterConfig(item.insurer_id);
        if (!config.url || !config.token) {
          item.status = 'BLOCKED_CONFIG';
          item.last_error = 'Endpoint/token do adapter não configurados.';
          item.next_attempt_at = undefined;
          item.updated_at = new Date().toISOString();
          persistDispatch(item);
          blocked += 1;
          continue;
        }

        const averbacao = dbStore.averbacoes.find((record) => record.id === item.averbacao_id);
        const policy = dbStore.policies.find((record) => record.id === item.policy_id);
        const tenant = dbStore.tenants.find((record) => record.id === item.tenant_id);
        const raw = averbacao
          ? dbStore.rawXmlStore.find((record) => record.id === averbacao.raw_xml_id)
          : undefined;

        if (!averbacao || !policy || !tenant || !raw) {
          item.status = 'FAILED_FINAL';
          item.last_error = 'Referência interna ausente para montar o despacho.';
          item.updated_at = new Date().toISOString();
          persistDispatch(item);
          failed += 1;
          continue;
        }

        item.status = 'SENDING';
        item.attempt_count += 1;
        item.last_attempt_at = new Date().toISOString();
        item.updated_at = item.last_attempt_at;
        persistDispatch(item);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(config.url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.token}`,
              'idempotency-key': item.idempotency_key,
              'x-arckatech-dispatch-id': item.id
            },
            body: JSON.stringify(buildPayload(item, averbacao, policy, tenant, raw.content_xml))
          });
          const text = await response.text();
          const body = parseJsonSafe(text);
          item.last_http_status = response.status;

          if (response.ok && !isRejectedBody(body)) {
            const externalNumber = body.numero_averbacao;
            const externalReference = body.external_reference || body.protocolo || externalNumber;
            item.status = 'CONFIRMED';
            item.external_number = externalNumber;
            item.external_reference = externalReference;
            item.confirmed_at = new Date().toISOString();
            item.next_attempt_at = undefined;
            item.last_error = undefined;
            item.updated_at = item.confirmed_at;
            persistDispatch(item);

            averbacao.status = 'SUCESSO';
            if (externalNumber) averbacao.numero_averbacao = externalNumber;
            averbacao.protocolo_seguradora = externalReference;
            averbacao.codigo_resposta = body.codigo || 'SUC-2000';
            averbacao.mensagem_resposta =
              body.mensagem ||
              `Averbação confirmada pela seguradora${externalNumber ? ` sob o número ${externalNumber}` : ''}.`;
            markFiscalDocument(
              averbacao.id,
              'AVERBADO',
              averbacao.codigo_resposta,
              averbacao.mensagem_resposta
            );
            dbStore.persist();
            confirmed += 1;
            continue;
          }

          const nonRetryableHttp = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
          const retryable = body.retryable !== false && !nonRetryableHttp;
          const message = body.mensagem || `Seguradora respondeu HTTP ${response.status}.`;

          if (!retryable || item.attempt_count >= MAX_ATTEMPTS) {
            item.status = 'FAILED_FINAL';
            item.next_attempt_at = undefined;
            item.last_error = message;
            item.updated_at = new Date().toISOString();
            persistDispatch(item);
            averbacao.status = 'ERRO';
            averbacao.codigo_resposta = body.codigo || 'INSURER_DISPATCH_REJECTED';
            averbacao.mensagem_resposta = message;
            markFiscalDocument(averbacao.id, 'RECUSADO', averbacao.codigo_resposta, message);
            dbStore.persist();
            failed += 1;
          } else {
            item.status = 'RETRY';
            item.next_attempt_at = retryAt(item.attempt_count);
            item.last_error = message;
            item.updated_at = new Date().toISOString();
            persistDispatch(item);
            retried += 1;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Falha desconhecida ao chamar adapter.';
          if (item.attempt_count >= MAX_ATTEMPTS) {
            item.status = 'FAILED_FINAL';
            item.next_attempt_at = undefined;
            item.last_error = message;
            item.updated_at = new Date().toISOString();
            persistDispatch(item);
            averbacao.status = 'ERRO';
            averbacao.codigo_resposta = 'INSURER_DISPATCH_RETRY_EXHAUSTED';
            averbacao.mensagem_resposta = 'Não foi possível confirmar a averbação na seguradora após as tentativas configuradas.';
            markFiscalDocument(
              averbacao.id,
              'RECUSADO',
              averbacao.codigo_resposta,
              averbacao.mensagem_resposta
            );
            dbStore.persist();
            failed += 1;
          } else {
            item.status = 'RETRY';
            item.next_attempt_at = retryAt(item.attempt_count);
            item.last_error = message;
            item.updated_at = new Date().toISOString();
            persistDispatch(item);
            retried += 1;
          }
        } finally {
          clearTimeout(timer);
        }
      } finally {
        processingIds.delete(item.id);
      }
    }

    return { processed: due.length, confirmed, retried, failed, blocked };
  }
}
