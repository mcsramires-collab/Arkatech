import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AverbacaoRequestDTO, AverbacaoResponseDTO, AverbacaoService } from '../averbacao';
import { dbStore } from '../dbStore';
import { XMLParserService } from '../xmlParser';
import {
  DocumentIngestionSource,
  FiscalDocument,
  FiscalDocumentStatus
} from '../../types';

export interface XmlIngestionInput extends AverbacaoRequestDTO {
  source: DocumentIngestionSource;
  app_base_url: string;
  original_filename?: string;
  nsu?: string;
  connector_id?: string;
  external_id?: string;
}

export interface XmlBatchItem {
  filename: string;
  xml_content: string;
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
  tentativas: BatchIngestionAttempt[];
}

/**
 * Ponto único de entrada para documentos que seguem para o motor de averbação.
 *
 * O registro FiscalDocument nasce antes do motor, garantindo rastreabilidade até para arquivos
 * recusados ou inválidos. O XML bruto continua sendo responsabilidade do fluxo já existente no
 * AverbacaoService/RawXMLStore, evitando duplicação de conteúdo sensível.
 */
export class DocumentIngestionService {
  private static createFiscalDocument(params: {
    tenant_id: string;
    source: DocumentIngestionSource;
    xml_content: string;
    original_filename?: string;
    nsu?: string;
    connector_id?: string;
    external_id?: string;
    policy_ids_attempted?: string[];
  }): FiscalDocument {
    const now = new Date().toISOString();
    const hash = crypto.createHash('sha256').update(params.xml_content, 'utf8').digest('hex');

    let parsed: ReturnType<typeof XMLParserService.parse> | undefined;
    try {
      parsed = XMLParserService.parse(params.xml_content);
    } catch {
      // Documento inválido também precisa existir no histórico de ingestão.
    }

    const record: FiscalDocument = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      source: params.source,
      status: 'RECEBIDO',
      content_hash_sha256: hash,
      original_filename: params.original_filename,
      tipo_documento: parsed?.tipoDocumento,
      chave_documento: parsed?.chaveDocumento,
      numero_documento: parsed?.numeroDocumento,
      serie_documento: parsed?.serie,
      cnpj_emissor: parsed?.cnpjEmitente,
      nsu: params.nsu,
      connector_id: params.connector_id,
      external_id: params.external_id,
      policy_ids_attempted: params.policy_ids_attempted ?? [],
      averbacao_ids: [],
      received_at: now
    };

    dbStore.fiscalDocuments.unshift(record);
    dbStore.persist();
    return record;
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
      original_filename,
      nsu,
      connector_id,
      external_id,
      ...averbacaoInput
    } = input;

    const document = this.createFiscalDocument({
      tenant_id: input.tenant_id,
      source,
      xml_content: input.xml_content,
      original_filename,
      nsu,
      connector_id,
      external_id,
      policy_ids_attempted: input.policy_id ? [input.policy_id] : []
    });

    this.markProcessing(document);
    const result = AverbacaoService.process(averbacaoInput, app_base_url);
    this.finishFiscalDocument(document, this.statusFromResponse(result), [result]);

    return result;
  }

  /**
   * Processa um conjunto de XMLs contra as apólices selecionadas pelo chamador.
   * Um único FiscalDocument é criado por arquivo, mesmo quando o arquivo é testado contra
   * múltiplas apólices; todas as tentativas e averbações resultantes ficam vinculadas a ele.
   */
  static processXmlBatch(input: BatchIngestionInput): BatchIngestionResult[] {
    return input.files.map((file) => {
      const document = this.createFiscalDocument({
        tenant_id: input.tenant_id,
        source: input.source,
        xml_content: file.xml_content,
        original_filename: file.filename,
        nsu: file.nsu,
        connector_id: file.connector_id,
        external_id: file.external_id,
        policy_ids_attempted: input.policies.map((policy) => policy.id)
      });

      this.markProcessing(document);

      if (input.policies.length === 0) {
        document.status = 'RECUSADO';
        document.codigo_resultado = 'NO_POLICY_CANDIDATE';
        document.mensagem_resultado = 'Nenhuma apólice candidata foi encontrada para processamento automático.';
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
            xml_content: file.xml_content
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
          (tentativa) => tentativa.status === 'sucesso' || tentativa.status === 'aviso'
        ),
        tentativas
      };
    });
  }
}
