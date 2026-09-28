import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { dbStore } from '../services/dbStore';
import { DocumentIngestionSource, FiscalDocumentStatus, TipoDocumento } from '../types';

const router = Router();

/**
 * GET /api/v1/tenant/fiscal-documents
 *
 * Lista documentos recebidos antes/independentemente da averbação.
 * Nunca devolve XML bruto, senha/certificado ou qualquer segredo do conector.
 */
router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const {
    status,
    source,
    tipo_documento,
    chave_documento,
    data_de,
    data_ate,
    page = '1',
    page_size = '50'
  } = req.query;

  let items = dbStore.fiscalDocuments.filter((document) => document.tenant_id === tenantId);

  if (status) {
    const wanted = String(status).toUpperCase() as FiscalDocumentStatus;
    items = items.filter((document) => document.status === wanted);
  }

  if (source) {
    const wanted = String(source).toUpperCase() as DocumentIngestionSource;
    items = items.filter((document) => document.source === wanted);
  }

  if (tipo_documento) {
    const wanted = String(tipo_documento).toUpperCase() as TipoDocumento;
    items = items.filter((document) => document.tipo_documento === wanted);
  }

  if (chave_documento) {
    items = items.filter((document) => document.chave_documento === String(chave_documento));
  }

  if (data_de) {
    const from = new Date(String(data_de));
    if (!Number.isNaN(from.getTime())) {
      items = items.filter((document) => new Date(document.received_at).getTime() >= from.getTime());
    }
  }

  if (data_ate) {
    const to = new Date(String(data_ate));
    if (!Number.isNaN(to.getTime())) {
      items = items.filter((document) => new Date(document.received_at).getTime() <= to.getTime());
    }
  }

  items = items.sort((a, b) => b.received_at.localeCompare(a.received_at));

  const parsedPage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const parsedPageSize = Math.min(200, Math.max(1, Number.parseInt(String(page_size), 10) || 50));
  const total = items.length;
  const start = (parsedPage - 1) * parsedPageSize;
  const paginated = items.slice(start, start + parsedPageSize);

  return res.json({
    status: 'sucesso',
    total,
    page: parsedPage,
    page_size: parsedPageSize,
    total_pages: Math.max(1, Math.ceil(total / parsedPageSize)),
    documents: paginated
  });
});

export default router;
