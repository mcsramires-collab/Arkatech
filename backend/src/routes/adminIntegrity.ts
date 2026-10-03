import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';
import { dbStore } from '../services/dbStore';
import { BusinessRuleRequest } from '../types';
import { policyPertenceAoAtor } from './adminHelpers';

const router = Router();

type SyncSection =
  | 'business_settings'
  | 'coverage_values'
  | 'sublimits'
  | 'titularity'
  | 'bypass';

const ALL_SYNC_SECTIONS: SyncSection[] = [
  'business_settings',
  'coverage_values',
  'sublimits',
  'titularity',
  'bypass'
];

/**
 * Sincronização atômica lógica das configurações compartilháveis entre os ramos 54 (RCTRC) e
 * 55 (RCDC). O source é a fonte de verdade e o target é substituído somente nas seções pedidas.
 *
 * O endpoint existe no backend para evitar o anti-pattern do Portal disparar uma sequência de
 * POST/DELETE independentes e terminar com 54 e 55 divergentes caso uma chamada intermediária
 * falhe. `dbStore.persist()` é chamado uma única vez após todas as coleções terem sido montadas.
 */
router.post(
  '/policy-config-sync',
  requirePermission('apolices', 'editar'),
  (req: BackofficeAuthenticatedRequest, res: Response) => {
    const { source_policy_id, target_policy_id } = req.body;
    const requestedSections = Array.isArray(req.body.sections)
      ? req.body.sections.map(String)
      : ALL_SYNC_SECTIONS;

    if (!source_policy_id || !target_policy_id || source_policy_id === target_policy_id) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'source_policy_id e target_policy_id distintos são obrigatórios.'
      });
    }
    if (!policyPertenceAoAtor(req, res, source_policy_id)) return;
    if (!policyPertenceAoAtor(req, res, target_policy_id)) return;

    const source = dbStore.policies.find((policy) => policy.id === source_policy_id);
    const target = dbStore.policies.find((policy) => policy.id === target_policy_id);
    if (!source || !target) {
      return res.status(404).json({ status: 'erro', mensagem: 'Apólice de origem ou destino não encontrada.' });
    }

    const isPair54_55 = new Set([source.ramo, target.ramo]);
    if (
      source.tenant_id !== target.tenant_id ||
      source.insurer_id !== target.insurer_id ||
      isPair54_55.size !== 2 ||
      !isPair54_55.has('RCTRC') ||
      !isPair54_55.has('RCDC')
    ) {
      return res.status(409).json({
        status: 'erro',
        mensagem:
          'A sincronização só é permitida entre RCTRC (54) e RCDC (55) do mesmo segurado e da mesma seguradora.'
      });
    }

    const invalidSections = requestedSections.filter(
      (section: string) => !ALL_SYNC_SECTIONS.includes(section as SyncSection)
    );
    if (invalidSections.length > 0) {
      return res.status(400).json({
        status: 'erro',
        mensagem: `Seções inválidas: ${invalidSections.join(', ')}.`
      });
    }
    const sections = requestedSections as SyncSection[];

    const snapshot = {
      policyBusinessSettings: [...dbStore.policyBusinessSettings],
      policyCoverageValues: [...dbStore.policyCoverageValues],
      policySublimites: [...dbStore.policySublimites],
      policyTitularityRules: [...dbStore.policyTitularityRules],
      policyBypassRules: [...dbStore.policyBypassRules]
    };

    const counts: Record<SyncSection, number> = {
      business_settings: 0,
      coverage_values: 0,
      sublimits: 0,
      titularity: 0,
      bypass: 0
    };

    try {
      if (sections.includes('business_settings')) {
        const sourceSettings = dbStore.policyBusinessSettings.find((item) => item.policy_id === source.id);
        dbStore.policyBusinessSettings = dbStore.policyBusinessSettings.filter(
          (item) => item.policy_id !== target.id
        );
        if (sourceSettings) {
          dbStore.policyBusinessSettings.push({
            ...sourceSettings,
            id: uuidv4(),
            policy_id: target.id,
            config: JSON.parse(JSON.stringify(sourceSettings.config)),
            updated_at: new Date().toISOString()
          });
          counts.business_settings = 1;
        }
      }

      if (sections.includes('coverage_values')) {
        const sourceValues = dbStore.policyCoverageValues.filter((item) => item.policy_id === source.id);
        dbStore.policyCoverageValues = dbStore.policyCoverageValues.filter(
          (item) => item.policy_id !== target.id
        );
        const now = new Date().toISOString();
        dbStore.policyCoverageValues.push(
          ...sourceValues.map((item) => ({
            ...item,
            id: uuidv4(),
            policy_id: target.id,
            created_at: now,
            updated_at: now
          }))
        );
        counts.coverage_values = sourceValues.length;
      }

      if (sections.includes('sublimits')) {
        const sourceItems = dbStore.policySublimites.filter((item) => item.policy_id === source.id);
        dbStore.policySublimites = dbStore.policySublimites.filter((item) => item.policy_id !== target.id);
        dbStore.policySublimites.push(
          ...sourceItems.map((item) => ({
            ...item,
            id: uuidv4(),
            policy_id: target.id,
            created_at: new Date().toISOString()
          }))
        );
        counts.sublimits = sourceItems.length;
      }

      if (sections.includes('titularity')) {
        const sourceItems = dbStore.policyTitularityRules.filter((item) => item.policy_id === source.id);
        dbStore.policyTitularityRules = dbStore.policyTitularityRules.filter(
          (item) => item.policy_id !== target.id
        );
        dbStore.policyTitularityRules.push(
          ...sourceItems.map((item) => ({ ...item, id: uuidv4(), policy_id: target.id }))
        );
        counts.titularity = sourceItems.length;
      }

      if (sections.includes('bypass')) {
        const sourceItems = dbStore.policyBypassRules.filter((item) => item.policy_id === source.id);
        dbStore.policyBypassRules = dbStore.policyBypassRules.filter((item) => item.policy_id !== target.id);
        dbStore.policyBypassRules.push(
          ...sourceItems.map((item) => ({ ...item, id: uuidv4(), policy_id: target.id }))
        );
        counts.bypass = sourceItems.length;
      }

      dbStore.persist();
      return res.json({
        status: 'sucesso',
        source_policy_id: source.id,
        target_policy_id: target.id,
        sections,
        copied: counts
      });
    } catch (error) {
      dbStore.policyBusinessSettings = snapshot.policyBusinessSettings;
      dbStore.policyCoverageValues = snapshot.policyCoverageValues;
      dbStore.policySublimites = snapshot.policySublimites;
      dbStore.policyTitularityRules = snapshot.policyTitularityRules;
      dbStore.policyBypassRules = snapshot.policyBypassRules;
      return res.status(500).json({
        status: 'erro',
        mensagem: 'Falha ao sincronizar configurações; nenhuma alteração foi mantida.'
      });
    }
  }
);

type ScopedBusinessRuleRequest = BusinessRuleRequest & {
  policy_id?: string;
  insurer_id?: string;
  ramo?: string;
  resolved_by?: string;
};

function resolveRequestInsurer(request: ScopedBusinessRuleRequest): string | undefined {
  if (request.insurer_id) return request.insurer_id;
  const insurerIds = Array.from(
    new Set(
      dbStore.policies
        .filter((policy) => policy.tenant_id === request.tenant_id)
        .map((policy) => policy.insurer_id)
    )
  );
  return insurerIds.length === 1 ? insurerIds[0] : undefined;
}

/**
 * Visão segura das solicitações de regra para a seguradora. Registros novos chegam com
 * insurer_id derivado da apólice no tenantIntegrity; registros legados só aparecem para uma
 * seguradora quando o tenant tinha uma única seguradora inequivocamente identificável.
 */
router.get(
  '/regras-solicitacoes',
  requirePermission('apolices', 'ver'),
  (req: BackofficeAuthenticatedRequest, res: Response) => {
    const actor = req.backoffice;
    if (!actor) return res.status(401).json({ status: 'erro', mensagem: 'Autenticação ausente.' });

    let items = dbStore.businessRuleRequests as ScopedBusinessRuleRequest[];
    if (actor.actor_type === 'SEGURADORA') {
      items = items.filter((item) => resolveRequestInsurer(item) === actor.insurer_id);
    } else if (actor.actor_type === 'INTERNAL_USER' && req.query.insurer_id) {
      items = items.filter((item) => resolveRequestInsurer(item) === String(req.query.insurer_id));
    } else if (actor.actor_type !== 'INTERNAL_USER') {
      return res.status(403).json({ status: 'erro', mensagem: 'Acesso não permitido.' });
    }

    if (req.query.tenant_id) {
      items = items.filter((item) => item.tenant_id === String(req.query.tenant_id));
    }
    if (req.query.status) {
      items = items.filter((item) => item.status === String(req.query.status).toUpperCase());
    }

    return res.json({
      status: 'sucesso',
      solicitacoes: [...items].sort((a, b) => b.created_at.localeCompare(a.created_at))
    });
  }
);

router.put(
  '/regras-solicitacoes/:id',
  requirePermission('apolices', 'editar'),
  (req: BackofficeAuthenticatedRequest, res: Response) => {
    const item = (dbStore.businessRuleRequests as ScopedBusinessRuleRequest[]).find(
      (request) => request.id === req.params.id
    );
    if (!item) return res.status(404).json({ status: 'erro', mensagem: 'Solicitação não encontrada.' });

    const actor = req.backoffice;
    if (!actor) return res.status(401).json({ status: 'erro', mensagem: 'Autenticação ausente.' });
    if (actor.actor_type === 'SEGURADORA' && resolveRequestInsurer(item) !== actor.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Esta solicitação não pertence à sua seguradora.' });
    }
    if (actor.actor_type !== 'SEGURADORA' && actor.actor_type !== 'INTERNAL_USER') {
      return res.status(403).json({ status: 'erro', mensagem: 'Acesso não permitido.' });
    }

    const status = String(req.body.status || '').toUpperCase();
    if (status !== 'APROVADA' && status !== 'REJEITADA') {
      return res.status(400).json({
        status: 'erro',
        mensagem: "status deve ser 'APROVADA' ou 'REJEITADA'."
      });
    }

    item.status = status;
    item.comentario_seguradora = req.body.comentario_seguradora;
    item.resolved_at = new Date().toISOString();
    item.resolved_by = actor.user_id ?? actor.actor_type;
    dbStore.persist();
    return res.json({ status: 'sucesso', solicitacao: item });
  }
);

export default router;
