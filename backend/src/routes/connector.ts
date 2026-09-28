import { normalizeCnpj, isCnpjFormatValid, sameCnpj } from '../utils/cnpj';
import { Router, Response } from 'express';
import {
  connectorAuthMiddleware,
  ConnectorAuthenticatedRequest
} from '../middleware/connectorAuthMiddleware';
import { ConnectorService } from '../services/connectorService';
import { ConnectorFiscalService } from '../services/connectorFiscalService';
import { FiscalSyncService } from '../services/fiscalSyncService';
import { dbStore } from '../services/dbStore';
import {
  ConnectorCertificateStatus,
  ConnectorSefazStatus,
  FiscalSyncProvider,
  FiscalSyncStatus,
  FiscalCaptureMode
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

    const normalizedCertificateCnpj = cnpj ? normalizeCnpj(cnpj) : undefined;
    if (normalizedCertificateCnpj && !isCnpjFormatValid(normalizedCertificateCnpj)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'CNPJ do certificado inválido. São aceitos CNPJs numéricos e alfanuméricos com 14 posições.'
      });
    }

    if (normalizedCertificateCnpj) {
      const tenant = dbStore.tenants.find((item) => item.id === connector.tenant_id);
      const additional = dbStore.tenantCnpjsAdicionais.some(
        (item) =>
          item.tenant_id === connector.tenant_id &&
          item.status === 'ATIVO' &&
          sameCnpj(item.cnpj, normalizedCertificateCnpj)
      );
      if (!tenant || (!sameCnpj(tenant.cnpj, normalizedCertificateCnpj) && !additional)) {
        return res.status(403).json({
          status: 'erro',
          mensagem: 'O certificado informado não pertence ao CNPJ principal nem a um CNPJ adicional/filial ativo deste cadastro.'
        });
      }
    }

    const updated = ConnectorService.updateCertificateStatus(connector, {
      status: normalizedStatus,
      cnpj: normalizedCertificateCnpj,
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
    const tenant = dbStore.tenants.find((item) => item.id === connector.tenant_id);
    return res.json({
      status: 'sucesso',
      connector_id: connector.id,
      environment: tenant?.ambiente === 'teste' ? 'HOMOLOGACAO' : 'PRODUCAO',
      providers: {
        nfe: connector.capabilities.includes('NFE_DFE'),
        cte: connector.capabilities.includes('CTE_DFE'),
        mdfe: connector.capabilities.includes('MDFE_DFE')
      },
      max_batch_size: 50,
      sync_state: FiscalSyncService.publicResumeState(connector)
    });
  }
);


router.post(
  '/fiscal-documents',
  connectorAuthMiddleware,
  (req: ConnectorAuthenticatedRequest, res: Response) => {
    const connector = req.connector!;
    const provider = String(req.body.provider || '').toUpperCase() as FiscalSyncProvider;
    const captureMode = String(req.body.capture_mode || 'DISTRIBUTION').toUpperCase() as FiscalCaptureMode;
    const allowedProviders: FiscalSyncProvider[] = ['NFE', 'CTE', 'MDFE'];
    const allowedCaptureModes: FiscalCaptureMode[] = ['DISTRIBUTION', 'OUTBOUND'];

    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ status: 'erro', mensagem: 'provider deve ser NFE, CTE ou MDFE.' });
    }
    if (!allowedCaptureModes.includes(captureMode)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'capture_mode deve ser DISTRIBUTION ou OUTBOUND.'
      });
    }
    if (!ConnectorFiscalService.supportsProvider(connector, provider)) {
      return res.status(403).json({
        status: 'erro',
        mensagem: `Este conector não possui a capability ${ConnectorFiscalService.requiredCapability(provider)}.`
      });
    }

    const documents = req.body.documents;
    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ status: 'erro', mensagem: 'documents deve conter ao menos um documento.' });
    }
    if (documents.length > 50) {
      return res.status(413).json({ status: 'erro', mensagem: 'O lote do Connector aceita no máximo 50 documentos.' });
    }

    const invalid = documents.find(
      (document: any) =>
        !document ||
        typeof document.xml !== 'string' ||
        document.xml.trim().length === 0 ||
        (captureMode === 'DISTRIBUTION' &&
          (typeof document.nsu !== 'string' || document.nsu.trim().length === 0))
    );
    if (invalid) {
      return res.status(400).json({
        status: 'erro',
        mensagem:
          captureMode === 'DISTRIBUTION'
            ? 'Na distribuição, cada documento precisa informar nsu e xml.'
            : 'Na captura OUTBOUND, cada documento precisa informar xml; NSU é opcional.'
      });
    }

    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    const results = ConnectorFiscalService.ingestBatch({
      connector,
      provider,
      capture_mode: captureMode,
      app_base_url: appBaseUrl,
      documents: documents.map((document: any) => ({
        nsu: typeof document.nsu === 'string' && document.nsu.trim() ? document.nsu.trim() : undefined,
        external_id:
          typeof document.external_id === 'string' && document.external_id.trim()
            ? document.external_id.trim()
            : undefined,
        xml: document.xml
      }))
    });

    return res.json({
      status: 'sucesso',
      provider,
      capture_mode: captureMode,
      total: results.length,
      processed: results.filter((item) => !item.duplicate).length,
      duplicates: results.filter((item) => item.duplicate).length,
      results
    });
  }
);

router.post(
  '/sync-result',
  connectorAuthMiddleware,
  (req: ConnectorAuthenticatedRequest, res: Response) => {
    const connector = req.connector!;
    const provider = String(req.body.provider || '').toUpperCase() as FiscalSyncProvider;
    const syncStatus = String(req.body.status || '').toUpperCase() as FiscalSyncStatus;

    const allowedProviders: FiscalSyncProvider[] = ['NFE', 'CTE', 'MDFE'];
    const allowedStatuses: FiscalSyncStatus[] = [
      'OK',
      'NO_DOCUMENTS',
      'RATE_LIMITED',
      'ERROR'
    ];

    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ status: 'erro', mensagem: 'provider deve ser NFE, CTE ou MDFE.' });
    }
    if (!ConnectorFiscalService.supportsProvider(connector, provider)) {
      return res.status(403).json({
        status: 'erro',
        mensagem: `Este conector não possui a capability ${ConnectorFiscalService.requiredCapability(provider)}.`
      });
    }
    if (!allowedStatuses.includes(syncStatus)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'status deve ser OK, NO_DOCUMENTS, RATE_LIMITED ou ERROR.'
      });
    }

    const cstat =
      req.body.cstat === undefined || req.body.cstat === null
        ? undefined
        : Number(req.body.cstat);
    if (cstat !== undefined && !Number.isInteger(cstat)) {
      return res.status(400).json({ status: 'erro', mensagem: 'cstat deve ser um número inteiro.' });
    }

    const documentCount =
      req.body.document_count === undefined ? 0 : Number(req.body.document_count);
    if (!Number.isInteger(documentCount) || documentCount < 0) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'document_count deve ser um número inteiro maior ou igual a zero.'
      });
    }

    if (req.body.next_sync_after) {
      const parsed = new Date(String(req.body.next_sync_after));
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ status: 'erro', mensagem: 'next_sync_after inválido.' });
      }
    }

    const state = FiscalSyncService.report(connector, {
      provider,
      status: syncStatus,
      ult_nsu: req.body.ult_nsu !== undefined ? String(req.body.ult_nsu) : undefined,
      max_nsu: req.body.max_nsu !== undefined ? String(req.body.max_nsu) : undefined,
      cstat,
      message: req.body.message !== undefined ? String(req.body.message) : undefined,
      document_count: documentCount,
      next_sync_after:
        req.body.next_sync_after !== undefined ? String(req.body.next_sync_after) : undefined
    });

    return res.json({ status: 'sucesso', sync: state });
  }
);

export default router;
