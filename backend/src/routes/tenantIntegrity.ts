import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { dbStore } from '../services/dbStore';
import { BusinessRuleRequest } from '../types';

const router = Router();

type ScopedBusinessRuleRequest = BusinessRuleRequest & {
  policy_id?: string;
  insurer_id?: string;
  ramo?: string;
};

/**
 * Versão segura do POST já consumido pelo Portal do Segurado.
 *
 * Quando `policy_id` é informado, insurer_id e ramo são sempre derivados da apólice no servidor.
 * Para preservar compatibilidade com o portal atual, `policy_id` pode ser omitido quando todas as
 * apólices ativas do tenant pertencem à mesma seguradora; se houver mais de uma seguradora, o
 * backend exige a apólice para não encaminhar a solicitação à contraparte errada.
 */
router.post('/regras-solicitacoes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { tipo, descricao } = req.body;
  const requestedPolicyId = req.body.policy_id ? String(req.body.policy_id) : undefined;

  if (!tipo) {
    return res.status(400).json({ status: 'erro', mensagem: 'tipo é obrigatório.' });
  }

  const activePolicies = dbStore.policies.filter(
    (policy) => policy.tenant_id === tenantId && policy.status === 'ATIVA'
  );
  if (activePolicies.length === 0) {
    return res.status(409).json({
      status: 'erro',
      mensagem: 'Não há apólice ativa para direcionar esta solicitação de regra.'
    });
  }

  const policy = requestedPolicyId
    ? activePolicies.find((item) => item.id === requestedPolicyId)
    : undefined;
  if (requestedPolicyId && !policy) {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'A apólice informada não pertence a esta empresa ou não está ativa.'
    });
  }

  const insurerIds = Array.from(new Set(activePolicies.map((item) => item.insurer_id)));
  if (!policy && insurerIds.length !== 1) {
    return res.status(409).json({
      status: 'erro',
      codigo: 'POLICY_REQUIRED_FOR_RULE_REQUEST',
      mensagem:
        'Esta empresa possui apólices de mais de uma seguradora. Informe policy_id para direcionar a solicitação corretamente.'
    });
  }

  const newRequest: ScopedBusinessRuleRequest = {
    id: uuidv4(),
    tenant_id: tenantId,
    policy_id: policy?.id,
    insurer_id: policy?.insurer_id ?? insurerIds[0],
    ramo: policy?.ramo,
    tipo: String(tipo),
    descricao: descricao !== undefined ? String(descricao) : undefined,
    status: 'PENDENTE',
    solicitante_nome: req.tenant!.tenant_user_nome || req.tenant!.razao_social,
    created_at: new Date().toISOString()
  };

  dbStore.businessRuleRequests.unshift(newRequest);
  dbStore.persist();
  return res.json({ status: 'sucesso', solicitacao: newRequest });
});

/** Mantém a consulta do próprio tenant compatível, agora incluindo o escopo policy/insurer. */
router.get('/regras-solicitacoes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const items = (dbStore.businessRuleRequests as ScopedBusinessRuleRequest[])
    .filter((request) => request.tenant_id === tenantId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return res.json({ status: 'sucesso', solicitacoes: items });
});

export default router;
