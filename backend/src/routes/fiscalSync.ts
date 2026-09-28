import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { ConnectorService } from '../services/connectorService';
import { FiscalSyncService } from '../services/fiscalSyncService';
import { dbStore } from '../services/dbStore';

const router = Router();

router.get('/status', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const connectors = dbStore.connectors
    .filter((connector) => connector.tenant_id === tenantId)
    .map((connector) => ({
      ...ConnectorService.publicView(connector),
      sync: FiscalSyncService.publicResumeState(connector)
    }));

  const active = connectors.filter((connector) => connector.status === 'ATIVO');

  return res.json({
    status: 'sucesso',
    summary: {
      connectors_total: connectors.length,
      connectors_active: active.length,
      connectors_revoked: connectors.length - active.length,
      documents_from_sefaz: dbStore.fiscalDocuments.filter(
        (document) => document.tenant_id === tenantId && document.source === 'SEFAZ'
      ).length
    },
    connectors
  });
});

export default router;
