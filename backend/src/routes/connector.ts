import { Router, Response } from 'express';
import {
  connectorAuthMiddleware,
  ConnectorAuthenticatedRequest
} from '../middleware/connectorAuthMiddleware';
import { ConnectorService } from '../services/connectorService';
import {
  ConnectorCertificateStatus,
  ConnectorSefazStatus
} from '../types';

const router = Router();

router.post(
  '/heartbeat',
  connectorAuthMiddleware,
  (req: ConnectorAuthenticatedRequest, res: Response) => {
    const connector = req.connector!;
    const { version, sefaz_status, last_sync_at } = req.body;

    const allowedSefaz: ConnectorSefazStatus[] = ['UNKNOWN', 'ONLINE', 'DEGRADED', 'OFFLINE'];
    if (sefaz_status && !allowedSefaz.includes(String(sefaz_status).toUpperCase() as ConnectorSefazStatus)) {
      return res.status(400).json({ status: 'erro', mensagem: 'sefaz_status inválido.' });
    }

    const updated = ConnectorService.heartbeat(connector, {
      version: version ? String(version) : undefined,
      sefaz_status: sefaz_status
        ? (String(sefaz_status).toUpperCase() as ConnectorSefazStatus)
        : undefined,
      last_sync_at: last_sync_at ? String(last_sync_at) : undefined
    });

    return res.json({ status: 'sucesso', connector: ConnectorService.publicView(updated) });
  }
);

router.put(
  '/certificate-status',
  connectorAuthMiddleware,
  (req: ConnectorAuthenticatedRequest, res: Response) => {
    const connector = req.connector!;
    const { status, cnpj, type, issuer, serial_number_hash, valid_from, valid_until } = req.body;

    const allowed: ConnectorCertificateStatus[] = [
      'NAO_CONFIGURADO',
      'VALID',
      'EXPIRING',
      'EXPIRED',
      'ERROR'
    ];
    const normalizedStatus = String(status || '').toUpperCase() as ConnectorCertificateStatus;
    if (!allowed.includes(normalizedStatus)) {
      return res.status(400).json({ status: 'erro', mensagem: 'status de certificado inválido.' });
    }

    const normalizedType = type ? String(type).toUpperCase() : undefined;
    if (normalizedType && normalizedType !== 'A1' && normalizedType !== 'A3') {
      return res.status(400).json({ status: 'erro', mensagem: 'type deve ser A1 ou A3.' });
    }

    const updated = ConnectorService.updateCertificateStatus(connector, {
      status: normalizedStatus,
      cnpj: cnpj ? String(cnpj).replace(/\D/g, '') : undefined,
      type: normalizedType as 'A1' | 'A3' | undefined,
      issuer: issuer ? String(issuer) : undefined,
      serial_number_hash: serial_number_hash ? String(serial_number_hash) : undefined,
      valid_from: valid_from ? String(valid_from) : undefined,
      valid_until: valid_until ? String(valid_until) : undefined
    });

    return res.json({ status: 'sucesso', connector: ConnectorService.publicView(updated) });
  }
);

router.get(
  '/sync-config',
  connectorAuthMiddleware,
  (req: ConnectorAuthenticatedRequest, res: Response) => {
    const connector = req.connector!;
    return res.json({
      status: 'sucesso',
      connector_id: connector.id,
      environment: 'PRODUCAO',
      providers: {
        nfe: connector.capabilities.includes('NFE_DFE'),
        cte: connector.capabilities.includes('CTE_DFE'),
        mdfe: connector.capabilities.includes('MDFE_DFE')
      },
      max_batch_size: 50
    });
  }
);

export default router;
