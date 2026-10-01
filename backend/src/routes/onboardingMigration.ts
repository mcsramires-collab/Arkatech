import { Router, Response } from 'express';
import multer from 'multer';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import {
  MigrationRamoCode,
  OnboardingMigrationError,
  onboardingMigrationService
} from '../services/onboardingMigration';
import { dbStore } from '../services/dbStore';

const router = Router();
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 }
});

function sendError(res: Response, error: unknown) {
  if (error instanceof OnboardingMigrationError) {
    return res.status(error.httpStatus).json({ status: 'erro', codigo: error.code, mensagem: error.message });
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ status: 'erro', codigo: 'ONBOARDING_UPLOAD_ERROR', mensagem: error.message });
  }
  console.error('[onboardingMigration] erro não tratado', error);
  return res.status(500).json({ status: 'erro', codigo: 'ONBOARDING_INTERNAL_ERROR', mensagem: 'Falha interna ao processar onboarding/migração.' });
}

function insurerContext(req: BackofficeAuthenticatedRequest): string {
  const actor = req.backoffice;
  if (!actor) throw new OnboardingMigrationError('BACKOFFICE_AUTH_REQUIRED', 401, 'Autenticação de backoffice ausente.');

  if (actor.actor_type === 'SEGURADORA' && actor.insurer_id) {
    return actor.insurer_id;
  }

  // Compatibilidade temporária com o BFF antigo: a chave interna é um superusuário sem insurer_id.
  // Nesse caso o contexto precisa vir em header explícito, nunca no body da regra/migração.
  if (actor.actor_type === 'INTERNAL_USER' && actor.role === 'ADM') {
    const raw = req.headers['x-insurer-id'];
    const insurerId = Array.isArray(raw) ? raw[0] : raw;
    if (!insurerId || !dbStore.insurers.some((insurer) => insurer.id === insurerId)) {
      throw new OnboardingMigrationError('INSURER_CONTEXT_REQUIRED', 400, 'Informe x-insurer-id válido para operações escopadas à seguradora.');
    }
    return insurerId;
  }

  throw new OnboardingMigrationError('INSURER_CONTEXT_FORBIDDEN', 403, 'Este ator não pode operar a jornada de migração da seguradora.');
}

function requireInternalReviewer(req: BackofficeAuthenticatedRequest): string {
  const actor = req.backoffice;
  if (!actor || actor.actor_type !== 'INTERNAL_USER' || !['ADM', 'AGENTE'].includes(actor.role)) {
    throw new OnboardingMigrationError('MIGRATION_REVIEW_FORBIDDEN', 403, 'A revisão documental é restrita à operação interna Arckatech.');
  }
  return actor.user_id;
}

function publicDetection(result: ReturnType<typeof onboardingMigrationService.detectMigration>) {
  return {
    migration_detected: result.migration_detected,
    cnpj: result.cnpj,
    insured_name: result.insured_name,
    eligible_ramos: result.eligible_ramos
  };
}

function publicRequest(request: ReturnType<typeof onboardingMigrationService.createMigrationRequest>) {
  const { requester_insurer_id: _insurer, tenant_id: _tenant, ...safe } = request;
  return safe;
}

function uploadedDocument(req: BackofficeAuthenticatedRequest): {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
} {
  if (req.file) {
    return {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer: req.file.buffer
    };
  }

  const filename = String(req.body?.filename ?? '').trim();
  const mimetype = String(req.body?.mimetype ?? 'application/octet-stream').trim();
  const contentBase64 = String(req.body?.content_base64 ?? '').trim();
  if (!filename || !contentBase64) {
    throw new OnboardingMigrationError(
      'DOCUMENT_REQUIRED',
      400,
      'Envie o arquivo no campo document ou informe filename + content_base64.'
    );
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
    throw new OnboardingMigrationError('INVALID_DOCUMENT_BASE64', 400, 'content_base64 inválido.');
  }

  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) {
    throw new OnboardingMigrationError('EMPTY_DOCUMENT', 400, 'Documento vazio.');
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new OnboardingMigrationError('DOCUMENT_TOO_LARGE', 413, 'O documento excede o limite de 15 MB.');
  }

  return { originalname: filename, mimetype, buffer };
}

router.post('/documents/analyze', upload.single('document'), async (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const documentInput = uploadedDocument(req);
    const analyzed = await onboardingMigrationService.analyzeDocument(insurerId, documentInput);
    const {
      insurer_id: _insurer,
      stored_path: _stored,
      migration,
      ...document
    } = analyzed;
    return res.status(201).json({
      status: 'sucesso',
      document,
      scenario: analyzed.scenario,
      migration: migration ? publicDetection(migration) : null
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/migration-detection', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const cnpj = String(req.query.cnpj ?? '');
    const result = onboardingMigrationService.detectMigration(cnpj, insurerId);
    return res.json({ status: 'sucesso', migration: publicDetection(result) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/migration-requests', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const selectedRamos = Array.isArray(req.body?.selected_ramos) ? req.body.selected_ramos.map(String) : [];
    const documentIds = Array.isArray(req.body?.document_ids) ? req.body.document_ids.map(String) : [];
    const request = onboardingMigrationService.createMigrationRequest({
      requesterInsurerId: insurerId,
      cnpj: String(req.body?.cnpj ?? ''),
      insuredName: req.body?.insured_name ? String(req.body.insured_name) : undefined,
      selectedRamos: selectedRamos as MigrationRamoCode[],
      documentIds,
      termAccepted: req.body?.term_accepted === true,
      scheduledStart: req.body?.scheduled_start ? String(req.body.scheduled_start) : undefined
    });
    return res.status(201).json({ status: 'sucesso', migration_request: publicRequest(request) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/migration-requests', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const requests = onboardingMigrationService.listRequests(insurerId).map(publicRequest);
    return res.json({ status: 'sucesso', migration_requests: requests });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/migration-requests/:id/review', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const reviewerId = requireInternalReviewer(req);
    const decision = String(req.body?.decision ?? '').toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      throw new OnboardingMigrationError('MIGRATION_REVIEW_DECISION_REQUIRED', 400, 'decision deve ser APPROVE ou REJECT.');
    }
    const request = onboardingMigrationService.reviewRequest(
      req.params.id,
      reviewerId,
      decision,
      req.body?.reason ? String(req.body.reason) : undefined
    );
    return res.json({ status: 'sucesso', migration_request: publicRequest(request) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/migration-requests/:id/complete-onboarding', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const targetPolicyIds = Array.isArray(req.body?.target_policy_ids) ? req.body.target_policy_ids.map(String) : [];
    const request = onboardingMigrationService.completeOnboarding(req.params.id, insurerId, targetPolicyIds);
    return res.json({ status: 'sucesso', migration_request: publicRequest(request) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/migration-requests/:id/effect', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const request = onboardingMigrationService.effectMigration(req.params.id, insurerId);
    return res.json({ status: 'sucesso', migration_request: publicRequest(request) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/migration-origin-notices', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const notices = onboardingMigrationService.listOriginNotices(insurerId);
    return res.json({ status: 'sucesso', notices });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/migration-origin-notices/:id/read', (req: BackofficeAuthenticatedRequest, res) => {
  try {
    const insurerId = insurerContext(req);
    const notice = onboardingMigrationService.markOriginNoticeRead(insurerId, req.params.id);
    return res.json({ status: 'sucesso', notice });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
