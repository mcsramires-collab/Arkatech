import { v4 as uuidv4 } from 'uuid';
import { AverbacaoRequestDTO, AverbacaoResponseDTO, AverbacaoService } from '../averbacao';
import { dbStore } from '../dbStore';
import { RawDocumentService } from '../rawDocumentService';
import { XMLParserService } from '../xmlParser';
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
      const sameFiscalIdentity =
        Boolean(parsed?.chaveDocumento) &&
        normalizeAlphanumeric(item.chave_documento) ===
          normalizeAlphanumeric(parsed?.chaveDocumento) &&
        (!parsed?.protocoloAceitacaoSefaz ||
          !item.protocolo_aceitacao_sefaz ||
          item.protocolo_aceitacao_sefaz === parsed.protocoloAceitacaoSefaz);

      if (!sameRaw && !sameFiscalIdentity) return false;

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
      return {
        status: 'erro',
        codigo: 'ERR-4005',
        mensagem: document.mensagem_resultado
      };
    }

    this.markProcessing(document);
    const result = AverbacaoService.process(
      { ...averbacaoInput, raw_xml_id: document.raw_xml_id },
      app_base_url
    );
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

        return {
          fiscal_document_id: document.id,
          arquivo: file.filename,
          aceito_em_alguma_apolice: false,
          tentativas: []
        };
      }

      const rawResponses: AverbacaoResponseDTO[] = [];
      const tentativas = input.policies.map((policy) => {
        const resultado = AverbacaoService.process(
          {
            tenant_id: input.tenant_id,
            ramo: policy.ramo,
            policy_id: policy.id,
            xml_content: file.xml_content,
            raw_xml_id: document.raw_xml_id
          },
          input.app_base_url
        );
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
