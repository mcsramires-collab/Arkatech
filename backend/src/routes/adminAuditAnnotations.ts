import { Router } from 'express';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { auditService, AuditAction } from '../services/auditService';
import { dbStore } from '../services/dbStore';

const router = Router();
const ALLOWED_ACTIONS = new Set<AuditAction>([
  'CREATE',
  'UPDATE',
  'STATUS_CHANGE',
  'REVERSAL',
  'BULK_UPDATE'
]);

function safeValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(safeValue);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/password|senha|secret|token|authorization|api.?key/i.test(key))
      .slice(0, 50)
      .map(([key, item]) => [key, safeValue(item)]);
    return Object.fromEntries(entries);
  }
  return String(value);
}

/**
 * Ponte de compatibilidade para os módulos do Portal da Seguradora que já chamavam
 * `registrarAuditoria()` apenas no browser. O evento passa a ser persistido no servidor e o ator
 * real vem exclusivamente do token de backoffice; o cliente não pode escolher insurer_id nem
 * identidade do usuário.
 *
 * Isto é uma ANOTAÇÃO do portal, não substitui a auditoria server-side dos contratos críticos
 * (ex.: Ficha atômica e reversão de parceria), que continuam gravando before/after diretamente
 * no backend. Conforme cada mutação antiga for instrumentada no servidor, a chamada client-side
 * correspondente pode ser removida sem perder histórico.
 */
router.post('/audit-events/portal', (req: BackofficeAuthenticatedRequest, res) => {
  const actor = req.backoffice;
  if (!actor || (actor.actor_type !== 'SEGURADORA' && actor.actor_type !== 'INTERNAL_USER')) {
    return res.status(403).json({ status: 'erro', mensagem: 'Auditoria disponível para seguradoras e administração Arckatech.' });
  }

  const moduleName = String(req.body?.module ?? '').trim().slice(0, 120);
  const entityType = String(req.body?.entity_type ?? 'PORTAL_ENTITY').trim().slice(0, 120);
  const entityId = String(req.body?.entity_id ?? '').trim().slice(0, 200);
  const action = String(req.body?.action ?? '').toUpperCase() as AuditAction;
  if (!moduleName || !entityId || !ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ status: 'erro', mensagem: 'module, entity_id e action válido são obrigatórios.' });
  }

  const policyId = req.body?.policy_id ? String(req.body.policy_id) : undefined;
  const tenantIdFromBody = req.body?.tenant_id ? String(req.body.tenant_id) : undefined;
  let tenantId = tenantIdFromBody;
  let insurerId = actor.insurer_id;

  if (policyId) {
    const policy = dbStore.policies.find((item) => item.id === policyId);
    if (!policy) return res.status(404).json({ status: 'erro', mensagem: 'Apólice não encontrada.' });
    if (actor.actor_type === 'SEGURADORA' && policy.insurer_id !== actor.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Esta apólice não pertence à sua seguradora.' });
    }
    tenantId = policy.tenant_id;
    insurerId = policy.insurer_id;
  } else if (tenantId && actor.actor_type === 'SEGURADORA') {
    const belongs = dbStore.policies.some(
      (policy) => policy.tenant_id === tenantId && policy.insurer_id === actor.insurer_id
    );
    if (!belongs) return res.status(403).json({ status: 'erro', mensagem: 'Este segurado não pertence à sua carteira.' });
  }

  const event = auditService.record({
    actor_type: actor.actor_type,
    actor_id: actor.user_id,
    actor_name: actor.nome,
    insurer_id: insurerId,
    tenant_id: tenantId,
    policy_id: policyId,
    module: moduleName,
    entity_type: entityType,
    entity_id: entityId,
    action,
    before: safeValue(req.body?.before),
    after: safeValue(req.body?.after),
    reason: req.body?.reason ? `[PORTAL] ${String(req.body.reason).slice(0, 500)}` : '[PORTAL] Evento informado após mutação concluída.'
  });

  return res.status(201).json({ status: 'sucesso', audit_event: event });
});

export default router;
