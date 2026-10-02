import { v4 as uuidv4 } from 'uuid';
import { AverbacaoRequestDTO, AverbacaoResponseDTO, AverbacaoService } from '../averbacao';
import { dbStore } from '../dbStore';
import { RawDocumentService } from '../rawDocumentService';
import { NotificationService } from '../notificationService';
import { XMLParserService } from '../xmlParser';
import { InsurerDispatchService } from '../insurerDispatchService';
import { normalizeAlphanumeric } from '../../utils/cnpj';
import {
  DocumentIngestionSource,
  FiscalCaptureMode,
  FiscalDocument,
  FiscalDocumentStatus
} from '../../types';

export interface XmlIngestionInput extends AverbacaoRequestDTO {
  source: DocumentIngestionSource;
  app_base_url: string;
  capture_mode?: FiscalCaptureMode;
  original_filename?: string;
  nsu?: string;
  connector_id?: string;
  external_id?: string;
}

export interface XmlBatchItem {
  filename: string;
  xml_content: string;
  capture_mode?: FiscalCaptureMode;
  nsu?: string;
  connector_id?: string;
  external_id?: string;
}

export interface PolicyTarget {
  id: string;
  numero_apolice: string;
  ramo: AverbacaoRequestDTO['ramo'];
}

export interface BatchIngestionInput {
  tenant_id: string;
  source: DocumentIngestionSource;
  app_base_url: string;
  files: XmlBatchItem[];
  policies: PolicyTarget[];
  no_policy_status?: Extract<FiscalDocumentStatus, 'RECUSADO' | 'IGNORADO'>;
  no_policy_code?: string;
  no_policy_message?: string;
}

export interface BatchIngestionAttempt {
  policy_id: string;
  numero_apolice: string;
  ramo: AverbacaoRequestDTO['ramo'];
  status: AverbacaoResponseDTO['status'];
  codigo: string;
  mensagem: string;
  averbacao_id?: string;
  numero_averbacao?: string;
  variaveis_faltantes?: string[];
}

export interface BatchIngestionResult {
  fiscal_document_id: string;
  arquivo: string;
  aceito_em_alguma_apolice: boolean;
  duplicate?: boolean;
  duplicate_of_id?: string;
  tentativas: BatchIngestionAttempt[];
}

function defaultCaptureMode(source: DocumentIngestionSource): FiscalCaptureMode {
  if (source === 'SEFAZ') return 'DISTRIBUTION';
  if (source === 'PORTAL' || source === 'API') return 'MANUAL';
  return 'INTEGRATION';
}

/**
 * Ponto único de entrada para documentos que seguem para o motor de averbação.
 *
 * Todo conteúdo bruto é persistido ANTES da decisão de negócio. Isso permite reprocessar
 * documentos sem apólice, recusados ou ignorados depois que cadastro/regras forem corrigidos.
 * A deduplicação é multicanal: Portal, API, SEFAZ, TMS e WhatsApp passam pela mesma identidade
 * fiscal antes de chamar o motor.
 */
export class DocumentIngestionService {
  private static notifyIfAttentionRequired(document: FiscalDocument): void {
    if (document.status === 'PENDENTE') {
      NotificationService.create({
        tenant_id: document.tenant_id,
        type: 'AVERBACAO_PENDENTE',
        severity: 'WARNING',
        title: 'Averbação pendente',
        message:
          document.mensagem_resultado ||
          'Um documento fiscal exige complemento ou análise antes de concluir a averbação.',
        context: {
          fiscal_document_id: document.id,
          tipo_documento: document.tipo_documento,
          chave_documento: document.chave_documento,
          source: document.source
        }
      });
    }

    if (document.status === 'RECUSADO' || document.status === 'ERRO') {
      NotificationService.create({
        tenant_id: document.tenant_id,
        type: 'AVERBACAO_RECUSADA',
        severity: 'ERROR',
        title: 'Documento não averbado',
        message:
          document.mensagem_resultado ||
          'Um documento fiscal não pôde ser averbado e precisa de atenção.',
        context: {
          fiscal_document_id: document.id,
          tipo_documento: document.tipo_documento,
          chave_documento: document.chave_documento,
          source: document.source,
          codigo: document.codigo_resultado
        }
      });
    }
  }

  private static prepareFiscalDocument(params: {
    tenant_id: string;
    source: DocumentIngestionSource;
    capture_mode?: FiscalCaptureMode;
    xml_content: string;
    original_filename?: string;
    nsu?: string;
    connector_id?: string;
    external_id?: string;
    policy_ids_attempted?: string[];
  }): { record: FiscalDocument; parsed?: ReturnType<typeof XMLParserService.parse> } {
    const now = new Date().toISOString();
    const raw = RawDocumentService.store(params.xml_content, params.tenant_id);

    let parsed: ReturnType<typeof XMLParserService.parse> | undefined;
    try {
      parsed = XMLParserService.parse(params.xml_content);
    } catch {
      // XML inválido também precisa existir no histórico e continuar reprocessável.
    }

    const requestedPolicies = params.policy_ids_attempted ?? [];
    const duplicate = dbStore.fiscalDocuments.find((item) => {
      if (item.tenant_id !== params.tenant_id) return false;
      if (!['AVERBADO', 'PENDENTE', 'DUPLICADO'].includes(item.status)) return false;

      const sameRaw = item.content_hash_sha256 === raw.hash_sha256;
      const sameExternalIdentity =
        Boolean(params.external_id) &&
        item.source === params.source &&
        item.external_id === params.external_id;
      const sameFiscalIdentity =
        Boolean(parsed?.chaveDocumento) &&
        normalizeAlphanumeric(item.chave_documento) ===
          normalizeAlphanumeric(parsed?.chaveDocumento) &&
        (!parsed?.protocoloAceitacaoSefaz ||
          !item.protocolo_aceitacao_sefaz ||
          item.protocolo_aceitacao_sefaz === parsed.protocoloAceitacaoSefaz);

      if (!sameRaw && !sameExternalIdentity && !sameFiscalIdentity) return false;

      // Se surgiu uma apólice nova ainda não tentada, o documento deve poder ser reprocessado.
      return requestedPolicies.every((policyId) => item.policy_ids_attempted.includes(policyId));
    });

    const record: FiscalDocument = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      source: params.source,
      capture_mode: params.capture_mode ?? defaultCaptureMode(params.source),
      status: duplicate ? 'DUPLICADO' : 'RECEBIDO',
      content_hash_sha256: raw.hash_sha256,
      raw_xml_id: raw.id,
      duplicate_of_id: duplicate?.id,
      original_filename: params.original_filename,
      tipo_documento: parsed?.tipoDocumento,
      chave_documento: parsed?.chaveDocumento,
      numero_documento: parsed?.numeroDocumento,
      serie_documento: parsed?.serie,
      cnpj_emissor: parsed?.cnpjEmitente,
      protocolo_aceitacao_sefaz: parsed?.protocoloAceitacaoSefaz,
      nsu: params.nsu,
      connector_id: params.connector_id,
      external_id: params.external_id,
      policy_ids_attempted: requestedPolicies,
      averbacao_ids: duplicate?.averbacao_ids ?? [],
      codigo_resultado: duplicate ? 'DUPLICATE_INGESTION' : undefined,
      mensagem_resultado: duplicate
        ? 'Documento já recebido anteriormente pelo mesmo cadastro; processamento duplicado ignorado.'
        : undefined,
      received_at: now,
      processed_at: duplicate ? now : undefined
    };

    dbStore.fiscalDocuments.unshift(record);
    dbStore.persist();
    return { record, parsed };
  }

  private static markProcessing(document: FiscalDocument): void {
    document.status = 'PROCESSANDO';
    dbStore.persist();
  }

  private static statusFromResponse(response: AverbacaoResponseDTO): FiscalDocumentStatus {
    if (response.status === 'sucesso' || response.status === 'aviso') return 'AVERBADO';
    if (response.status === 'pendente') return 'PENDENTE';
    if (response.codigo === 'ERR-4007') return 'DUPLICADO';
    if (response.codigo === 'ERR-4005') return 'ERRO';
    return 'RECUSADO';
  }

  /**
   * O motor interno continua síncrono e valida todas as regras. Em produção, porém, o aceite
   * interno não significa que a seguradora registrou a averbação. Aqui convertemos esse aceite
   * em despacho externo pendente e só o worker volta a marcar SUCESSO depois do ACK do adapter.
   * Ambientes de teste e XML tpAmb=2 preservam o comportamento sintético do laboratório.
   */
  private static queueExternalConfirmation(
    tenantId: string,
    response: AverbacaoResponseDTO
  ): AverbacaoResponseDTO {
    if (!response.averbacao_id || (response.status !== 'sucesso' && response.status !== 'aviso')) {
      return response;
    }

    const tenant = dbStore.tenants.find((item) => item.id === tenantId);
    const averbacao = dbStore.averbacoes.find((item) => item.id === response.averbacao_id);
    if (!tenant || !averbacao) return response;
    if (tenant.ambiente !== 'producao' || averbacao.tp_amb_sefaz === 2) return response;

    const policy = dbStore.policies.find((item) => item.id === averbacao.policy_id);
    if (!policy) {
      (averbacao as any).status = 'ERRO';
      averbacao.codigo_resposta = 'INSURER_DISPATCH_POLICY_NOT_FOUND';
      averbacao.mensagem_resposta = 'A apólice deixou de existir antes do despacho à seguradora.';
      delete averbacao.numero_averbacao;
      dbStore.persist();
      return {
        status: 'erro',
        codigo: averbacao.codigo_resposta,
        mensagem: averbacao.mensagem_resposta,
        averbacao_id: averbacao.id,
        protocolo_interno_averbacao: averbacao.protocolo_interno_averbacao
      };
    }

    const dispatch = InsurerDispatchService.enqueue({ averbacao, policy, tenant });
    delete averbacao.numero_averbacao;
    (averbacao as any).status = 'PENDENTE_ENVIO';
    (averbacao as any).insurer_dispatch_id = dispatch.id;
    averbacao.codigo_resposta = 'PENDING_INSURER_DISPATCH';
    averbacao.mensagem_resposta =
      dispatch.status === 'BLOCKED_CONFIG'
        ? 'Averbação validada internamente, mas o adapter da seguradora ainda não está configurado. O envio permanece pendente.'
        : 'Averbação validada internamente e enfileirada para confirmação da seguradora.';
    dbStore.persist();

    return {
      status: 'pendente',
      codigo: averbacao.codigo_resposta,
      mensagem: averbacao.mensagem_resposta,
      averbacao_id: averbacao.id,
      protocolo_interno_averbacao: averbacao.protocolo_interno_averbacao,
      valor_considerado_averbacao: averbacao.valor_considerado_averbacao,
      regras_internas_aplicadas: averbacao.regras_internas_aplicadas,
      timestamp: averbacao.timestamp,
      hash_validacao: response.hash_validacao
    };
  }

  private static finishFiscalDocument(
    document: FiscalDocument,
    status: FiscalDocumentStatus,
    responses: AverbacaoResponseDTO[]
  ): void {
    const averbacaoIds = responses
      .map((response) => response.averbacao_id)
      .filter((id): id is string => Boolean(id));

    document.status = status;
    document.averbacao_ids = Array.from(new Set(averbacaoIds));
    document.codigo_resultado = responses.map((response) => response.codigo).filter(Boolean).join(',');
    document.mensagem_resultado = responses.map((response) => response.mensagem).filter(Boolean).join(' | ');
    document.processed_at = new Date().toISOString();
    dbStore.persist();
    this.notifyIfAttentionRequired(document);
  }

  private static consolidateBatchStatus(responses: AverbacaoResponseDTO[]): FiscalDocumentStatus {
    if (responses.some((response) => response.status === 'sucesso' || response.status === 'aviso')) {
      return 'AVERBADO';
    }
    if (responses.some((response) => response.status === 'pendente')) return 'PENDENTE';
    if (responses.length > 0 && responses.every((response) => response.codigo === 'ERR-4007')) {
      return 'DUPLICADO';
    }
    if (responses.length > 0 && responses.every((response) => response.codigo === 'ERR-4005')) {
      return 'ERRO';
    }
    return 'RECUSADO';
  }

  static processXml(input: XmlIngestionInput): AverbacaoResponseDTO {
    const {
      source,
      app_base_url,
      capture_mode,
      original_filename,
      nsu,
      connector_id,
      external_id,
      ...averbacaoInput
    } = input;

    const { record: document, parsed } = this.prepareFiscalDocument({
      tenant_id: input.tenant_id,
      source,
      capture_mode,
      xml_content: input.xml_content,
      original_filename,
      nsu,
      connector_id,
      external_id,
      policy_ids_attempted: input.policy_id ? [input.policy_id] : []
    });

    if (document.status === 'DUPLICADO') {
      return {
        status: 'aviso',
        codigo: 'DUPLICATE_INGESTION',
        mensagem: document.mensagem_resultado ?? 'Documento duplicado.',
        averbacao_id: document.averbacao_ids[0]
      };
    }

    if (!parsed) {
      document.status = 'ERRO';
      document.codigo_resultado = 'ERR-4005';
      document.mensagem_resultado = 'XML inválido ou formato fiscal não reconhecido.';
      document.processed_at = new Date().toISOString();
      dbStore.persist();
      this.notifyIfAttentionRequired(document);
      return {
        status: 'erro',
        codigo: 'ERR-4005',
        mensagem: document.mensagem_resultado
      };
    }

    this.markProcessing(document);
    const internalResult = AverbacaoService.process(
      { ...averbacaoInput, raw_xml_id: document.raw_xml_id },
      app_base_url
    );
    const result = this.queueExternalConfirmation(input.tenant_id, internalResult);
    this.finishFiscalDocument(document, this.statusFromResponse(result), [result]);

    return result;
  }

  /**
   * Processa um conjunto de XMLs contra as apólices selecionadas pelo chamador.
   * Um FiscalDocument é criado para cada recebimento, inclusive duplicados, preservando origem.
   */
  static processXmlBatch(input: BatchIngestionInput): BatchIngestionResult[] {
    return input.files.map((file) => {
      const { record: document, parsed } = this.prepareFiscalDocument({
        tenant_id: input.tenant_id,
        source: input.source,
        capture_mode: file.capture_mode,
        xml_content: file.xml_content,
        original_filename: file.filename,
        nsu: file.nsu,
        connector_id: file.connector_id,
        external_id: file.external_id,
        policy_ids_attempted: input.policies.map((policy) => policy.id)
      });

      if (document.status === 'DUPLICADO') {
        const original = document.duplicate_of_id
          ? dbStore.fiscalDocuments.find((item) => item.id === document.duplicate_of_id)
          : undefined;
        return {
          fiscal_document_id: document.id,
          arquivo: file.filename,
          aceito_em_alguma_apolice:
            original?.status === 'AVERBADO' || original?.status === 'PENDENTE',
          duplicate: true,
          duplicate_of_id: document.duplicate_of_id,
          tentativas: []
        };
      }

      if (!parsed) {
        document.status = 'ERRO';
        document.codigo_resultado = 'ERR-4005';
        document.mensagem_resultado = 'XML inválido ou formato fiscal não reconhecido.';
        document.processed_at = new Date().toISOString();
        dbStore.persist();
        return {
          fiscal_document_id: document.id,
          arquivo: file.filename,
          aceito_em_alguma_apolice: false,
          tentativas: []
        };
      }

      this.markProcessing(document);

      if (input.policies.length === 0) {
        document.status = input.no_policy_status ?? 'RECUSADO';
        document.codigo_resultado = input.no_policy_code ?? 'NO_POLICY_CANDIDATE';
        document.mensagem_resultado =
          input.no_policy_message ??
          'Nenhuma apólice candidata foi encontrada para processamento automático.';
        document.processed_at = new Date().toISOString();
        dbStore.persist();
        this.notifyIfAttentionRequired(document);

        return {
          fiscal_document_id: document.id,
          arquivo: file.filename,
          aceito_em_alguma_apolice: false,
          tentativas: []
        };
      }

      const rawResponses: AverbacaoResponseDTO[] = [];
      const tentativas = input.policies.map((policy) => {
        const internalResult = AverbacaoService.process(
          {
            tenant_id: input.tenant_id,
            ramo: policy.ramo,
            policy_id: policy.id,
            xml_content: file.xml_content,
            raw_xml_id: document.raw_xml_id
          },
          input.app_base_url
        );
        const resultado = this.queueExternalConfirmation(input.tenant_id, internalResult);
        rawResponses.push(resultado);

        return {
          policy_id: policy.id,
          numero_apolice: policy.numero_apolice,
          ramo: policy.ramo,
          status: resultado.status,
          codigo: resultado.codigo,
          mensagem: resultado.mensagem,
          averbacao_id: resultado.averbacao_id,
          numero_averbacao: resultado.numero_averbacao,
          variaveis_faltantes: resultado.variaveis_faltantes
        };
      });

      this.finishFiscalDocument(document, this.consolidateBatchStatus(rawResponses), rawResponses);

      return {
        fiscal_document_id: document.id,
        arquivo: file.filename,
        aceito_em_alguma_apolice: tentativas.some(
          (tentativa) =>
            tentativa.status === 'sucesso' ||
            tentativa.status === 'aviso' ||
            tentativa.status === 'pendente'
        ),
        tentativas
      };
    });
  }
}
