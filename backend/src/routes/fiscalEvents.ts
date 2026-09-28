import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { dbStore } from '../services/dbStore';
import { FiscalEventStatus, FiscalSyncProvider } from '../types';

const router = Router();

router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const { status, provider, chave_documento, page = '1', page_size = '50' } = req.query;
  let items = dbStore.fiscalEvents.filter((event) => event.tenant_id === tenantId);

  if (status) {
    const wanted = String(status).toUpperCase() as FiscalEventStatus;
    items = items.filter((event) => event.status === wanted);
  }
  if (provider) {
    const wanted = String(provider).toUpperCase() as FiscalSyncProvider;
    items = items.filter((event) => event.provider === wanted);
  }
  if (chave_documento) {
    items = items.filter((event) => event.chave_documento === String(chave_documento));
  }

  items = items.sort((a, b) => b.received_at.localeCompare(a.received_at));

  const parsedPage = Math.max(1, Number.parseInt(String(page), 10) || 1);
  const parsedPageSize = Math.min(200, Math.max(1, Number.parseInt(String(page_size), 10) || 50));
  const total = items.length;
  const start = (parsedPage - 1) * parsedPageSize;

  return res.json({
    status: 'sucesso',
    total,
    page: parsedPage,
    page_size: parsedPageSize,
    total_pages: total === 0 ? 0 : Math.ceil(total / parsedPageSize),
    events: items.slice(start, start + parsedPageSize)
  });
});

export default router;
