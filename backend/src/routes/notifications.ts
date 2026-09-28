import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { NotificationService } from '../services/notificationService';

const router = Router();

router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const unreadOnly = String(req.query.unread_only || '').toLowerCase() === 'true';
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  const notifications = NotificationService.list({
    tenant_id: tenantId,
    tenant_user_id: req.tenant!.tenant_user_id,
    unread_only: unreadOnly,
    limit
  });

  return res.json({
    status: 'sucesso',
    unread_count: NotificationService.list({
      tenant_id: tenantId,
      tenant_user_id: req.tenant!.tenant_user_id,
      unread_only: true,
      limit: 200
    }).length,
    notifications
  });
});

router.put('/read-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const count = NotificationService.markAllRead(tenantId, req.tenant!.tenant_user_id);
  return res.json({ status: 'sucesso', marcadas_como_lidas: count });
});

router.put('/:id/read', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const notification = NotificationService.markRead(
    req.tenant!.tenant_id,
    req.params.id,
    req.tenant!.tenant_user_id
  );
  if (!notification) {
    return res.status(404).json({ status: 'erro', mensagem: 'Notificação não encontrada.' });
  }

  return res.json({ status: 'sucesso', notification });
});

export default router;
