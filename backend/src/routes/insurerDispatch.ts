import { Router } from 'express';
import { InsurerDispatchService, InsurerDispatchStatus } from '../services/insurerDispatchService';

const router = Router();

router.get('/', (req, res) => {
  const status = req.query.status ? String(req.query.status) as InsurerDispatchStatus : undefined;
  const allowed: InsurerDispatchStatus[] = [
    'PENDING',
    'SENDING',
    'RETRY',
    'BLOCKED_CONFIG',
    'CONFIRMED',
    'FAILED_FINAL'
  ];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ status: 'erro', mensagem: 'status de despacho inválido.' });
  }
  const items = InsurerDispatchService.list(status);
  return res.json({ status: 'sucesso', total: items.length, dispatches: items });
});

router.post('/process', async (req, res) => {
  const requested = Number(req.body?.limit ?? 20);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 100)) : 20;
  const result = await InsurerDispatchService.processDue(limit);
  return res.json({ status: 'sucesso', ...result });
});

router.post('/:id/retry', (req, res) => {
  const item = InsurerDispatchService.retry(req.params.id);
  if (!item) {
    return res.status(404).json({ status: 'erro', mensagem: 'Despacho não encontrado.' });
  }
  return res.json({ status: 'sucesso', dispatch: item });
});

export default router;
