import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { ConnectorService } from '../services/connectorService';
import { dbStore } from '../services/dbStore';

const router = Router();

router.post('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const { device_id, device_name, version, os, capabilities } = req.body;
  if (!device_id || !device_name || !version || !os) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'device_id, device_name, version e os são obrigatórios.'
    });
  }

  try {
    const result = ConnectorService.register({
      tenant_id: tenantId,
      device_id: String(device_id),
      device_name: String(device_name),
      version: String(version),
      os: String(os),
      capabilities: Array.isArray(capabilities) ? capabilities.map(String) : []
    });

    return res.status(201).json({
      status: 'sucesso',
      connector: ConnectorService.publicView(result.connector),
      device_token: result.device_token
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'CONNECTOR_ALREADY_EXISTS') {
      return res.status(409).json({
        status: 'erro',
        mensagem: 'Já existe um conector ativo registrado para este device_id.'
      });
    }
    throw error;
  }
});

router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const items = dbStore.connectors
    .filter((connector) => connector.tenant_id === tenantId)
    .map(ConnectorService.publicView);

  return res.json({ status: 'sucesso', connectors: items });
});

router.get('/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const connector = dbStore.connectors.find(
    (item) => item.id === req.params.id && item.tenant_id === tenantId
  );
  if (!connector) {
    return res.status(404).json({ status: 'erro', mensagem: 'Conector não encontrado.' });
  }
  return res.json({ status: 'sucesso', connector: ConnectorService.publicView(connector) });
});

router.delete('/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const connector = ConnectorService.revoke(tenantId, req.params.id);
  if (!connector) {
    return res.status(404).json({ status: 'erro', mensagem: 'Conector não encontrado.' });
  }
  return res.json({
    status: 'sucesso',
    mensagem: 'Conector revogado com sucesso.',
    connector: ConnectorService.publicView(connector)
  });
});

export default router;
