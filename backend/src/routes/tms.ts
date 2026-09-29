import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { ConnectorFiscalService } from '../services/connectorFiscalService';
import { dbStore } from '../services/dbStore';
import { DocumentIngestionService } from '../services/ingestion/documentIngestion';
import { MultiFormatFiscalParser } from '../services/ingestion/multiFormatFiscalParser';
import { XMLParserService } from '../services/xmlParser';

const router = Router();

router.get('/capabilities', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  return res.json({
    status: 'sucesso',
    api: 'TMS_GENERIC_V1',
    documentos: ['CTE', 'NFE', 'MDFE', 'NFSE'],
    payloads: ['xml_content', 'data'],
    idempotencia: 'source_system + external_id por tenant',
    max_batch_size: 200,
    autenticacao: 'Bearer token emitido por POST /api/v1/auth/token'
  });
});

/**
 * POST /api/v1/tms/documents
 *
 * Contrato genérico para qualquer TMS. O adapter do fornecedor só precisa traduzir sua saída para:
 * - external_id: id único no sistema de origem
 * - xml_content: XML fiscal completo; OU
 * - data: objeto tabular com tipo_documento, chave/numero, valor e demais campos disponíveis
 *
 * O TMS não escolhe ramo/apólice. O backend usa as regras de documentos aceitos da própria apólice.
 */
router.post('/documents', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const sourceSystem = String(req.body.source_system || '').trim();
  const documents = req.body.documents;

  if (!sourceSystem) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'source_system é obrigatório (ex.: TOTVS, SENIOR, ESL, TMS_INTERNO).'
    });
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'documents deve conter ao menos um documento.'
    });
  }
  if (documents.length > 200) {
    return res.status(413).json({
      status: 'erro',
      mensagem: 'O lote TMS aceita no máximo 200 documentos por requisição.'
    });
  }

  const appBaseUrl = `${req.protocol}://${req.get('host')}`;
  const allTenantPolicies = dbStore.policies.filter((policy) => policy.tenant_id === tenantId);
  const results: any[] = [];

  for (const document of documents) {
    const externalId = String(document?.external_id || '').trim();
    if (!externalId) {
      results.push({
        external_id: null,
        status: 'ERRO',
        codigo: 'EXTERNAL_ID_REQUIRED',
        mensagem: 'external_id é obrigatório para idempotência do TMS.'
      });
      continue;
    }

    let content = typeof document.xml_content === 'string' ? document.xml_content.trim() : '';

    if (!content && document.data && typeof document.data === 'object') {
      const normalized = MultiFormatFiscalParser.fromStructuredRow(document.data);
      if (!normalized.content) {
        results.push({
          external_id: externalId,
          status: 'ERRO',
          codigo: 'INSUFFICIENT_FISCAL_DATA',
          mensagem: normalized.warnings.join('; ')
        });
        continue;
      }
      content = normalized.content;
    }

    if (!content) {
      results.push({
        external_id: externalId,
        status: 'ERRO',
        codigo: 'DOCUMENT_CONTENT_REQUIRED',
        mensagem: 'Informe xml_content ou data com os campos fiscais mínimos.'
      });
      continue;
    }

    let parsed;
    try {
      parsed = XMLParserService.parse(content);
    } catch (error) {
      // O conteúdo inválido ainda é enviado ao pipeline para manter rastreabilidade/raw.
      const [ingestion] = DocumentIngestionService.processXmlBatch({
        tenant_id: tenantId,
        source: 'TMS',
        app_base_url: appBaseUrl,
        files: [{
          filename: `TMS-${sourceSystem}-${externalId}`,
          xml_content: content,
          capture_mode: 'INTEGRATION',
          external_id: `${sourceSystem}:${externalId}`
        }],
        policies: []
      });

      results.push({
        external_id: externalId,
        fiscal_document_id: ingestion?.fiscal_document_id,
        status: 'ERRO',
        codigo: 'INVALID_FISCAL_DOCUMENT',
        mensagem: error instanceof Error ? error.message : 'Documento fiscal inválido.'
      });
      continue;
    }

    const policies = ConnectorFiscalService.resolveAutomaticPolicies(tenantId, parsed.tipoDocumento, parsed.dataEmissao);
    const notConfigured = allTenantPolicies.length > 0 && policies.length === 0;

    const [ingestion] = DocumentIngestionService.processXmlBatch({
      tenant_id: tenantId,
      source: 'TMS',
      app_base_url: appBaseUrl,
      files: [{
        filename: `TMS-${sourceSystem}-${externalId}`,
        xml_content: content,
        capture_mode: 'INTEGRATION',
        external_id: `${sourceSystem}:${externalId}`
      }],
      policies,
      no_policy_status: notConfigured ? 'IGNORADO' : 'RECUSADO',
      no_policy_code: notConfigured ? 'DOCUMENT_TYPE_NOT_CONFIGURED' : 'NO_POLICY_CANDIDATE',
      no_policy_message: notConfigured
        ? `O documento ${parsed.tipoDocumento} chegou via TMS, mas nenhuma apólice está configurada para esse tipo.`
        : 'Documento recebido via TMS, mas nenhuma apólice candidata existe para este cadastro.'
    });

    const fiscalDocument = ingestion
      ? dbStore.fiscalDocuments.find((item) => item.id === ingestion.fiscal_document_id)
      : undefined;

    results.push({
      external_id: externalId,
      fiscal_document_id: ingestion?.fiscal_document_id,
      duplicate: Boolean(ingestion?.duplicate),
      status: fiscalDocument?.status ?? 'ERRO',
      tipo_documento: parsed.tipoDocumento,
      chave_documento: parsed.chaveDocumento,
      averbacao_ids: fiscalDocument?.averbacao_ids ?? [],
      tentativas: ingestion?.tentativas ?? []
    });
  }

  const accepted = results.filter((item) => item.status === 'AVERBADO').length;
  const duplicated = results.filter((item) => item.duplicate === true).length;
  const errors = results.filter((item) => item.status === 'ERRO').length;

  return res.json({
    status: errors > 0 ? 'aviso' : 'sucesso',
    source_system: sourceSystem,
    total: results.length,
    averbados: accepted,
    duplicados: duplicated,
    erros: errors,
    results
  });
});

export default router;
