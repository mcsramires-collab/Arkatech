import { Router } from 'express';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';
import { resolveInsurerId, tenantPertenceAoAtor } from './adminHelpers';
import { OperationalMovementService } from '../services/operationalMovementService';

const router = Router();

router.get('/insurer-movements', requirePermission('averbacoes', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const insurerId = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurerId) return;

  const tenantId = req.query.tenant_id ? String(req.query.tenant_id) : undefined;
  if (tenantId && !tenantPertenceAoAtor(req, res, tenantId)) return;

  const result = OperationalMovementService.listForInsurer(insurerId, {
    tenant_id: tenantId,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    tipo_documento: req.query.tipo_documento ? String(req.query.tipo_documento) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined
  });

  return res.json({ status: 'sucesso', ...result });
});

export default router;
