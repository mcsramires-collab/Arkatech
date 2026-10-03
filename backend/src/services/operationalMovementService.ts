import { dbStore } from './dbStore';
import { XMLParserService } from './xmlParser';

export interface InsurerMovementFilters {
  tenant_id?: string;
  from?: string;
  to?: string;
  status?: string;
  tipo_documento?: string;
  limit?: number;
}

export interface InsurerMovementRow {
  id: string;
  averbacao_id: string;
  fiscal_document_id?: string;
  tenant_id: string;
  segurado_nome: string;
  segurado_cnpj: string;
  policy_id: string;
  numero_apolice: string;
  ramo: string;
  status: string;
  codigo_resultado: string;
  mensagem_resultado: string;
  numero_averbacao?: string;
  protocolo_interno_averbacao: string;
  tipo_documento: string;
  chave_documento: string;
  numero_documento?: string;
  serie_documento?: string;
  data_emissao?: string;
  data_processamento: string;
  uf_origem?: string;
  uf_destino?: string;
  produto_predominante?: string;
  data_embarque?: string;
  cnpj_emissor?: string;
  cnpj_remetente?: string;
  cnpj_destinatario?: string;
  cnpj_tomador?: string;
  cnpj_transportador?: string;
  valor_carga: number;
  valor_considerado_averbacao: number;
  lmi_no_momento_envio?: number;
  sublimite_no_momento_envio?: number;
  source?: string;
  capture_mode?: string;
  protocolo_aceitacao_sefaz?: string;
  regras_internas_aplicadas: string[];
}

function parseDate(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function safeParse(rawXmlId?: string) {
  if (!rawXmlId) return undefined;
  const raw = dbStore.rawXmlStore.find((item) => item.id === rawXmlId);
  if (!raw) return undefined;
  try {
    return XMLParserService.parse(raw.content_xml);
  } catch {
    return undefined;
  }
}

function fiscalDocumentFor(averbacaoId: string, rawXmlId: string) {
  return dbStore.fiscalDocuments.find((document) => document.averbacao_ids.includes(averbacaoId))
    ?? dbStore.fiscalDocuments.find((document) => document.raw_xml_id === rawXmlId);
}

function statusLabel(status: string) {
  if (status === 'SUCESSO') return 'AVERBADO';
  if (status === 'PENDENTE_APROVACAO') return 'PENDENTE';
  if (status === 'CANCELADO' || status === 'CANCELADO_NAO_AVERBADO') return 'CANCELADO';
  return 'RECUSADO';
}

export class OperationalMovementService {
  static listForInsurer(insurerId: string, filters: InsurerMovementFilters = {}) {
    const visiblePolicies = dbStore.policies.filter((policy) => policy.insurer_id === insurerId);
    const policyById = new Map(visiblePolicies.map((policy) => [policy.id, policy]));
    const tenantById = new Map(dbStore.tenants.map((tenant) => [tenant.id, tenant]));
    const fromMs = parseDate(filters.from);
    const toMs = parseDate(filters.to);
    const limit = Math.max(1, Math.min(Number(filters.limit ?? 500), 2000));

    const rows: InsurerMovementRow[] = [];
    for (const averbacao of dbStore.averbacoes) {
      const policy = policyById.get(averbacao.policy_id);
      if (!policy) continue;
      if (filters.tenant_id && averbacao.tenant_id !== filters.tenant_id) continue;
      if (filters.status && statusLabel(averbacao.status) !== filters.status.toUpperCase()) continue;
      if (filters.tipo_documento && averbacao.tipo_documento !== filters.tipo_documento.toUpperCase()) continue;

      const fiscal = fiscalDocumentFor(averbacao.id, averbacao.raw_xml_id);
      const parsed = safeParse(averbacao.raw_xml_id);
      const dataEmissao = parsed?.dataEmissao;
      const timestampMs = parseDate(dataEmissao) ?? parseDate(averbacao.timestamp) ?? 0;
      if (fromMs !== undefined && timestampMs < fromMs) continue;
      if (toMs !== undefined && timestampMs > toMs) continue;

      const tenant = tenantById.get(averbacao.tenant_id);
      rows.push({
        id: `${averbacao.id}:${fiscal?.id ?? 'no-fiscal'}`,
        averbacao_id: averbacao.id,
        fiscal_document_id: fiscal?.id,
        tenant_id: averbacao.tenant_id,
        segurado_nome: tenant?.nome_fantasia || tenant?.razao_social || averbacao.tenant_id,
        segurado_cnpj: tenant?.cnpj || '',
        policy_id: policy.id,
        numero_apolice: policy.numero_apolice,
        ramo: policy.ramo,
        status: statusLabel(averbacao.status),
        codigo_resultado: averbacao.codigo_resposta,
        mensagem_resultado: averbacao.mensagem_resposta,
        numero_averbacao: averbacao.numero_averbacao,
        protocolo_interno_averbacao: averbacao.protocolo_interno_averbacao,
        tipo_documento: averbacao.tipo_documento,
        chave_documento: averbacao.chave_documento,
        numero_documento: averbacao.numero_documento,
        serie_documento: averbacao.serie_documento,
        data_emissao: dataEmissao,
        data_processamento: averbacao.timestamp,
        uf_origem: parsed?.ufOrigem,
        uf_destino: parsed?.ufDestino,
        produto_predominante: parsed?.produtoPredominante,
        data_embarque: typeof parsed?.tagsMap?.['DATA_EMBARQUE'] === 'string'
          ? parsed.tagsMap['DATA_EMBARQUE']
          : undefined,
        cnpj_emissor: averbacao.cnpj_emissor ?? parsed?.cnpjEmitente,
        cnpj_remetente: averbacao.cnpj_remetente ?? parsed?.cnpjRemetente,
        cnpj_destinatario: averbacao.cnpj_destinatario ?? parsed?.cnpjDestinatario,
        cnpj_tomador: averbacao.cnpj_tomador ?? parsed?.cnpjTomador,
        cnpj_transportador: parsed?.cnpjTransportador,
        valor_carga: averbacao.valor_carga,
        valor_considerado_averbacao: averbacao.valor_considerado_averbacao,
        lmi_no_momento_envio: averbacao.lmi_no_momento_envio,
        sublimite_no_momento_envio: averbacao.sublimite_no_momento_envio,
        source: fiscal?.source,
        capture_mode: fiscal?.capture_mode,
        protocolo_aceitacao_sefaz: averbacao.protocolo_aceitacao_sefaz,
        regras_internas_aplicadas: averbacao.regras_internas_aplicadas
      });
    }

    rows.sort((a, b) => (parseDate(b.data_emissao) ?? parseDate(b.data_processamento) ?? 0) -
      (parseDate(a.data_emissao) ?? parseDate(a.data_processamento) ?? 0));
    const limited = rows.slice(0, limit);

    const summary = {
      total: rows.length,
      averbadas: rows.filter((row) => row.status === 'AVERBADO').length,
      pendentes: rows.filter((row) => row.status === 'PENDENTE').length,
      recusadas: rows.filter((row) => row.status === 'RECUSADO').length,
      canceladas: rows.filter((row) => row.status === 'CANCELADO').length,
      valor_carga_total: rows.reduce((sum, row) => sum + row.valor_carga, 0),
      valor_considerado_total: rows.reduce((sum, row) => sum + row.valor_considerado_averbacao, 0),
      por_documento: Object.fromEntries(
        ['CTE', 'NFE', 'NFSE', 'MDFE'].map((tipo) => [tipo, rows.filter((row) => row.tipo_documento === tipo).length])
      )
    };

    return { rows: limited, summary, total_before_limit: rows.length };
  }
}
