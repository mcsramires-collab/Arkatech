import {
  Connector,
  FiscalCaptureMode,
  FiscalSyncProvider,
  Policy,
  RamoApolice,
  TipoDocumento
} from '../types';
import { dbStore } from './dbStore';
import { XMLParserService } from './xmlParser';
import {
  BatchIngestionResult,
  DocumentIngestionService,
  PolicyTarget
} from './ingestion/documentIngestion';

export interface ConnectorFiscalDocumentInput {
  nsu?: string;
  external_id?: string;
  xml: string;
}

export interface ConnectorFiscalDocumentResult {
  nsu?: string;
  duplicate: boolean;
  fiscal_document_id: string;
  status?: string;
  ingestion?: BatchIngestionResult;
}

const RAMOS: RamoApolice[] = ['RCTRC', 'RCDC', 'RCV'];

function normalizeDocumentLabel(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function policyAcceptsDocument(policyId: string, tipoDocumento: TipoDocumento): boolean {
  const settings = dbStore.policyBusinessSettings.find((item) => item.policy_id === policyId);
  const configured = settings?.config?.['regras:documentos-aceitos'];

  // Mesmo default do Portal da Seguradora: quando nunca configurado, CT-e é o documento aceito.
  const accepted = Array.isArray(configured) && configured.length > 0 ? configured : ['CT-e'];
  return accepted.some((item) => normalizeDocumentLabel(item) === tipoDocumento);
}

export class ConnectorFiscalService {
  static requiredCapability(provider: FiscalSyncProvider): string {
    return `${provider}_DFE`;
  }

  static supportsProvider(connector: Connector, provider: FiscalSyncProvider): boolean {
    return connector.capabilities.includes(this.requiredCapability(provider));
  }

  /**
   * Seleciona no máximo uma apólice por ramo E somente quando a configuração da apólice
   * aceita o tipo do documento. Isso formaliza a regra documento → ramo/apólice em vez de
   * simplesmente tentar RCTR-C, RC-DC e RC-V para todo XML recebido.
   */
  static resolveAutomaticPolicies(tenantId: string, tipoDocumento: TipoDocumento): PolicyTarget[] {
    const now = Date.now();
    const policies = dbStore.policies.filter(
      (policy) => policy.tenant_id === tenantId && policyAcceptsDocument(policy.id, tipoDocumento)
    );

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
    capture_mode: FiscalCaptureMode;
    documents: ConnectorFiscalDocumentInput[];
    app_base_url: string;
  }): ConnectorFiscalDocumentResult[] {
    const results: ConnectorFiscalDocumentResult[] = [];
    const allTenantPolicies = dbStore.policies.filter(
      (policy) => policy.tenant_id === params.connector.tenant_id
    );

    for (const document of params.documents) {
      let parsedDocument: ReturnType<typeof XMLParserService.parse> | undefined;
      let tipoDocumento: TipoDocumento | undefined;
      try {
        parsedDocument = XMLParserService.parse(document.xml);
        tipoDocumento = parsedDocument.tipoDocumento;
      } catch {
        // O pipeline central vai registrar o XML bruto e classificá-lo como ERRO.
      }

      const expectedDocumentType: TipoDocumento = params.provider;
      const providerMismatch =
        Boolean(tipoDocumento) && tipoDocumento !== expectedDocumentType;
      const outboundNotAuthorized =
        params.capture_mode === 'OUTBOUND' &&
        Boolean(parsedDocument) &&
        (!parsedDocument?.protocoloAceitacaoSefaz ||
          !['100', '150'].includes(parsedDocument.cStatAutorizacaoSefaz ?? ''));

      const policies =
        tipoDocumento && !providerMismatch && !outboundNotAuthorized
          ? this.resolveAutomaticPolicies(params.connector.tenant_id, tipoDocumento)
          : [];

      const reference = document.nsu ?? document.external_id ?? 'outbound';
      const externalId =
        document.external_id ??
        (document.nsu
          ? `${params.capture_mode}:${params.provider}:${document.nsu}`
          : undefined);

      const noPolicyBecauseNotConfigured =
        Boolean(tipoDocumento) &&
        !providerMismatch &&
        !outboundNotAuthorized &&
        allTenantPolicies.length > 0 &&
        policies.length === 0;

      const [ingestion] = DocumentIngestionService.processXmlBatch({
        tenant_id: params.connector.tenant_id,
        source: 'SEFAZ',
        app_base_url: params.app_base_url,
        files: [{
          filename: `${params.provider}-${reference}.xml`,
          xml_content: document.xml,
          capture_mode: params.capture_mode,
          nsu: document.nsu,
          connector_id: params.connector.id,
          external_id: externalId
        }],
        policies,
        no_policy_status:
          providerMismatch || outboundNotAuthorized || noPolicyBecauseNotConfigured
            ? 'IGNORADO'
            : 'RECUSADO',
        no_policy_code: providerMismatch
          ? 'PROVIDER_DOCUMENT_MISMATCH'
          : outboundNotAuthorized
            ? 'SEFAZ_NOT_AUTHORIZED'
            : noPolicyBecauseNotConfigured
              ? 'DOCUMENT_TYPE_NOT_CONFIGURED'
              : 'NO_POLICY_CANDIDATE',
        no_policy_message: providerMismatch
          ? `O provider ${params.provider} não corresponde ao tipo ${tipoDocumento} do XML recebido.`
          : outboundNotAuthorized
            ? 'Documento OUTBOUND armazenado, mas não averbado porque o retorno não comprova autorização do SEFAZ (protocolo/cStat 100 ou 150).'
            : noPolicyBecauseNotConfigured
              ? `O documento ${tipoDocumento} foi capturado, mas nenhuma apólice do cadastro está configurada para averbar esse tipo.`
              : 'Documento capturado, mas nenhuma apólice candidata existe para este cadastro.'
      });

      if (!ingestion) {
        throw new Error('INGESTION_RESULT_MISSING');
      }

      const fiscalDocument = dbStore.fiscalDocuments.find(
        (item) => item.id === ingestion.fiscal_document_id
      );

      results.push({
        nsu: document.nsu,
        duplicate: Boolean(ingestion.duplicate),
        fiscal_document_id: ingestion.fiscal_document_id,
        status: fiscalDocument?.status,
        ingestion
      });
    }

    return results;
  }
}
