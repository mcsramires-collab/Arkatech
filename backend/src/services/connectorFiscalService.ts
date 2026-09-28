import crypto from 'crypto';
import { Connector, FiscalSyncProvider, Policy, RamoApolice } from '../types';
import { dbStore } from './dbStore';
import {
  BatchIngestionResult,
  DocumentIngestionService,
  PolicyTarget
} from './ingestion/documentIngestion';

export interface ConnectorFiscalDocumentInput {
  nsu: string;
  xml: string;
}

export interface ConnectorFiscalDocumentResult {
  nsu: string;
  duplicate: boolean;
  fiscal_document_id: string;
  status?: string;
  ingestion?: BatchIngestionResult;
}

const RAMOS: RamoApolice[] = ['RCTRC', 'RCDC', 'RCV'];

export class ConnectorFiscalService {
  static requiredCapability(provider: FiscalSyncProvider): string {
    return `${provider}_DFE`;
  }

  static supportsProvider(connector: Connector, provider: FiscalSyncProvider): boolean {
    return connector.capabilities.includes(this.requiredCapability(provider));
  }

  /**
   * Seleciona no máximo uma apólice por ramo. Repete a preferência já adotada no motor:
   * ativa e ainda não vencida primeiro; se não houver, mantém a primeira cadastrada para
   * permitir que o próprio AverbacaoService aplique o tratamento de inatividade/vigência.
   */
  static resolveAutomaticPolicies(tenantId: string): PolicyTarget[] {
    const now = Date.now();
    const policies = dbStore.policies.filter((policy) => policy.tenant_id === tenantId);

    return RAMOS.flatMap((ramo) => {
      const candidates = policies.filter((policy) => policy.ramo === ramo);
      if (candidates.length === 0) return [];

      const usable = candidates.find(
        (policy) =>
          policy.status === 'ATIVA' &&
          !(policy.vigencia_fim && new Date(policy.vigencia_fim).getTime() < now)
      );
      const selected: Policy = usable ?? candidates[0]!;
      return [{
        id: selected.id,
        numero_apolice: selected.numero_apolice,
        ramo: selected.ramo
      }];
    });
  }

  static ingestBatch(params: {
    connector: Connector;
    provider: FiscalSyncProvider;
    documents: ConnectorFiscalDocumentInput[];
    app_base_url: string;
  }): ConnectorFiscalDocumentResult[] {
    const policies = this.resolveAutomaticPolicies(params.connector.tenant_id);
    const results: ConnectorFiscalDocumentResult[] = [];

    for (const document of params.documents) {
      const externalId = `${params.provider}:${document.nsu}`;
      const hash = crypto.createHash('sha256').update(document.xml, 'utf8').digest('hex');

      const existing = dbStore.fiscalDocuments.find(
        (item) =>
          item.tenant_id === params.connector.tenant_id &&
          item.connector_id === params.connector.id &&
          item.external_id === externalId &&
          item.content_hash_sha256 === hash
      );

      if (existing) {
        results.push({
          nsu: document.nsu,
          duplicate: true,
          fiscal_document_id: existing.id,
          status: existing.status
        });
        continue;
      }

      const [ingestion] = DocumentIngestionService.processXmlBatch({
        tenant_id: params.connector.tenant_id,
        source: 'SEFAZ',
        app_base_url: params.app_base_url,
        files: [{
          filename: `${params.provider}-${document.nsu}.xml`,
          xml_content: document.xml,
          nsu: document.nsu,
          connector_id: params.connector.id,
          external_id: externalId
        }],
        policies
      });

      if (!ingestion) {
        throw new Error('INGESTION_RESULT_MISSING');
      }

      const fiscalDocument = dbStore.fiscalDocuments.find(
        (item) => item.id === ingestion.fiscal_document_id
      );

      results.push({
        nsu: document.nsu,
        duplicate: false,
        fiscal_document_id: ingestion.fiscal_document_id,
        status: fiscalDocument?.status,
        ingestion
      });
    }

    return results;
  }
}
