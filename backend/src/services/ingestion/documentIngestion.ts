import { AverbacaoRequestDTO, AverbacaoResponseDTO, AverbacaoService } from '../averbacao';

export type DocumentIngestionSource =
  | 'API'
  | 'PORTAL'
  | 'SEFAZ'
  | 'TMS'
  | 'WHATSAPP'
  | 'INTERNAL';

export interface XmlIngestionInput extends AverbacaoRequestDTO {
  source: DocumentIngestionSource;
  app_base_url: string;
}

export interface XmlBatchItem {
  filename: string;
  xml_content: string;
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
  numero_averbacao?: string;
  variaveis_faltantes?: string[];
}

export interface BatchIngestionResult {
  arquivo: string;
  aceito_em_alguma_apolice: boolean;
  tentativas: BatchIngestionAttempt[];
}

/**
 * Ponto único de entrada para documentos que seguem para o motor de averbação.
 *
 * Nesta primeira etapa a camada aceita XML e preserva integralmente o comportamento
 * do AverbacaoService. As próximas fontes (SEFAZ, TMS, WhatsApp, PDF/XLS/TXT)
 * devem normalizar seu conteúdo antes de chamar este serviço, evitando que cada
 * canal replique regras de negócio de averbação.
 *
 * "source" é metadado de origem e propositalmente ainda não altera a decisão do
 * motor. Ele existe desde já para que observabilidade, auditoria e persistência
 * de documentos recebidos possam ser adicionadas sem mudar os contratos dos canais.
 */
export class DocumentIngestionService {
  static processXml(input: XmlIngestionInput): AverbacaoResponseDTO {
    const { source: _source, app_base_url, ...averbacaoInput } = input;
    return AverbacaoService.process(averbacaoInput, app_base_url);
  }

  /**
   * Processa um conjunto de XMLs contra as apólices selecionadas pelo chamador.
   * Mantém a granularidade arquivo x apólice usada hoje pelo Portal do Segurado.
   */
  static processXmlBatch(input: BatchIngestionInput): BatchIngestionResult[] {
    return input.files.map((file) => {
      const tentativas = input.policies.map((policy) => {
        const resultado = this.processXml({
          tenant_id: input.tenant_id,
          source: input.source,
          app_base_url: input.app_base_url,
          ramo: policy.ramo,
          policy_id: policy.id,
          xml_content: file.xml_content
        });

        return {
          policy_id: policy.id,
          numero_apolice: policy.numero_apolice,
          ramo: policy.ramo,
          status: resultado.status,
          codigo: resultado.codigo,
          mensagem: resultado.mensagem,
          numero_averbacao: resultado.numero_averbacao,
          variaveis_faltantes: resultado.variaveis_faltantes
        };
      });

      return {
        arquivo: file.filename,
        aceito_em_alguma_apolice: tentativas.some(
          (tentativa) => tentativa.status === 'sucesso' || tentativa.status === 'aviso'
        ),
        tentativas
      };
    });
  }
}
