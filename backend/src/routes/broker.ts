import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Tenant, Policy, DelegationAction } from '../types';
import { resolveRequiresApproval, criarApprovalRequest, aplicarAcaoDelegada } from '../services/delegatedActions';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';

const router = Router();

/**
 * "requirePermission() por módulo", item 2 combinado com o usuário (Backlog, seção 4) — mesmo
 * padrão aplicado em admin.ts. Sem consumidor real hoje (Portal da Corretora não existe — ver
 * Backlog), mas ligado por consistência: quando o portal existir, o RbacProfile de uma CORRETORA
 * (ex.: `perfilAnalistaCorretora` do seed — apolices:ver, clientes:editar, coberturas:ver,
 * relatorios:ver, usuarios/delegacao_corretora:sem_acesso) já vale de verdade, sem precisar de
 * mais uma rodada de trabalho nesta rota nem risco de esquecer.
 */

/**
 * Todas as rotas aqui são escopadas por broker_id (a corretora) e, opcionalmente,
 * insurer_id (para restringir à carteira de uma seguradora específica). Uma corretora
 * NUNCA enxerga a carteira de outra corretora, mesmo que atendam à mesma seguradora.
 *
 * Fase 4 do item "Login real + RBAC" (Backlog, seção 4): antes, `broker_id` vinha sempre livre
 * em query/body — qualquer chamador com a chave interna (`x-internal-api-key`, compartilhada por
 * todo o backoffice) podia pedir a carteira de QUALQUER corretora só informando o `broker_id`
 * dela. Como nenhum frontend consome estas rotas hoje (o Portal da Corretora ainda não existe —
 * ver Backlog), essa migração pôde ser feita de uma vez, sem risco de quebrar tráfego real: agora
 * `resolveBrokerId()` abaixo SEMPRE deriva o `broker_id` da identidade autenticada
 * (`req.backoffice`, populado por `backofficeOrInternalKeyMiddleware`) quando quem chama é uma
 * CORRETORA — o valor enviado em query/body para esse campo é ignorado nesse caso. ADM da
 * Arckatech (login real ou a chave interna, tratada como ADM sintético) continua podendo informar
 * `broker_id` livremente, para dar suporte/gerenciar qualquer carteira.
 */
function resolveBrokerId(
  req: BackofficeAuthenticatedRequest,
  res: Response,
  brokerIdDaRequisicao: unknown
): string | null {
  const ator = req.backoffice;
  if (!ator) {
    res.status(401).json({ status: 'erro', mensagem: 'Autenticação de backoffice ausente.' });
    return null;
  }

  if (ator.actor_type === 'CORRETORA') {
    if (!ator.broker_id) {
      res.status(403).json({
        status: 'erro',
        mensagem: 'Seu usuário não está vinculado a nenhuma corretora — sem acesso a esta área.'
      });
      return null;
    }
    return ator.broker_id;
  }

  if (ator.actor_type === 'INTERNAL_USER') {
    if (!brokerIdDaRequisicao || typeof brokerIdDaRequisicao !== 'string') {
      res.status(400).json({ status: 'erro', mensagem: 'broker_id é obrigatório.' });
      return null;
    }
    return brokerIdDaRequisicao;
  }

  res.status(403).json({
    status: 'erro',
    mensagem: 'Esta área é exclusiva de corretoras e da administração Arckatech.'
  });
  return null;
}

// --- Carteira de Clientes da Corretora ---
router.get('/clients', requirePermission('clientes', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { insurer_id } = req.query;
  const broker_id = resolveBrokerId(req, res, req.query.broker_id);
  if (!broker_id) return;

  let policies = dbStore.policies.filter((p) => p.broker_id === broker_id);
  if (insurer_id) policies = policies.filter((p) => p.insurer_id === insurer_id);

  const tenantIds = Array.from(new Set(policies.map((p) => p.tenant_id)));
  const clients = tenantIds.map((tid) => {
    const tenant = dbStore.tenants.find((t) => t.id === tid);
    const clientPolicies = policies.filter((p) => p.tenant_id === tid);
    return { tenant, policies: clientPolicies };
  });

  return res.json({ status: 'sucesso', clients });
});

// --- Averbações da Carteira (foco em recusas/pendências) ---
router.get('/averbacoes', requirePermission('relatorios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { insurer_id, apenas_recusadas } = req.query;
  const broker_id = resolveBrokerId(req, res, req.query.broker_id);
  if (!broker_id) return;

  let policies = dbStore.policies.filter((p) => p.broker_id === broker_id);
  if (insurer_id) policies = policies.filter((p) => p.insurer_id === insurer_id);
  const policyIds = new Set(policies.map((p) => p.id));

  let averbacoes = dbStore.averbacoes.filter((a) => policyIds.has(a.policy_id));
  if (apenas_recusadas === 'true') {
    averbacoes = averbacoes.filter((a) => a.status === 'ERRO');
  }

  return res.json({ status: 'sucesso', averbacoes });
});

// --- Criar Cliente em Nome da Seguradora (sujeito à matriz de delegação) ---
router.post('/clients', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const {
    insurer_id,
    co_broker_id,
    assessoria_id,
    cnpj,
    razao_social,
    nome_fantasia,
    ramo,
    numero_apolice,
    lmi,
    vigencia_inicio,
    vigencia_fim,
    permitir_inativo_vencido,
    aceita_averbacao_como_destinatario,
    contato_nome,
    contato_email,
    contato_telefone_fixo,
    contato_celular
  } = req.body;
  const broker_id = resolveBrokerId(req, res, req.body.broker_id);
  if (!broker_id) return;

  if (!insurer_id || !cnpj || !razao_social || !ramo || !numero_apolice) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_id, cnpj, razao_social, ramo e numero_apolice são obrigatórios.'
    });
  }

  const action: DelegationAction = 'CRIAR_CLIENTE';
  const delegation = dbStore.delegationPermissions.find(
    (d) => d.insurer_id === insurer_id && d.broker_id === broker_id && d.action === action
  );
  const requiresApproval = delegation ? delegation.requires_approval : true; // por padrão, exige aprovação se não configurado

  if (requiresApproval) {
    const approvalRequest = {
      id: uuidv4(),
      insurer_id,
      broker_id,
      action,
      payload: {
        cnpj,
        razao_social,
        nome_fantasia,
        co_broker_id,
        assessoria_id,
        ramo,
        numero_apolice,
        lmi,
        vigencia_inicio,
        vigencia_fim,
        permitir_inativo_vencido,
        aceita_averbacao_como_destinatario,
        contato_nome,
        contato_email,
        contato_telefone_fixo,
        contato_celular
      },
      status: 'PENDENTE' as const,
      created_at: new Date().toISOString()
    };
    dbStore.approvalRequests.push(approvalRequest);
    dbStore.persist();

    return res.json({
      status: 'pendente_aprovacao',
      mensagem: 'Esta ação exige aprovação da seguradora. Sua solicitação foi registrada e ficará pendente até ser analisada.',
      approval_request: approvalRequest
    });
  }

  // Sem exigência de aprovação — aplica direto (mesma lógica do cadastro pela seguradora)
  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  let tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpjLimpo);

  if (tenant) {
    const policyConflitante = dbStore.policies.find(
      (p) => p.tenant_id === tenant!.id && p.ramo === ramo && p.status === 'ATIVA' && p.insurer_id !== insurer_id
    );
    if (policyConflitante) {
      return res.status(409).json({
        status: 'conflito',
        mensagem: `Já existe uma apólice ativa do ramo ${ramo} para este CNPJ vinculada a outra seguradora.`,
        tenant_id: tenant.id,
        ramo
      });
    }
  } else {
    tenant = {
      id: `tenant_${cnpjLimpo}_${Date.now()}`,
      cnpj,
      razao_social,
      status: 'ATIVO',
      ambiente: 'producao',
      client_id: `client_prod_${cnpjLimpo}`,
      client_secret_hash: `secret_${cnpjLimpo}`,
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: new Date().toISOString(),
      contato_nome,
      contato_email,
      contato_telefone_fixo,
      contato_celular,
      conta_ativada: false
    };
    dbStore.tenants.push(tenant);
    dbStore.activationTokens.push({
      id: uuidv4(),
      tenant_id: tenant.id,
      token: `act_${uuidv4()}`,
      termo_versao: 'v1',
      aceite: false,
      expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    });
  }

  const newPolicy: Policy = {
    id: `pol_${String(ramo).toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id: tenant.id,
    insurer_id,
    broker_id,
    co_broker_id,
    assessoria_id,
    status: 'ATIVA',
    permitir_inativo_vencido: Boolean(permitir_inativo_vencido),
    vigencia_inicio: vigencia_inicio || new Date().toISOString(),
    vigencia_fim: vigencia_fim || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    lmi: lmi !== undefined ? Number(lmi) : undefined,
    aceita_averbacao_como_destinatario: Boolean(aceita_averbacao_como_destinatario)
  };
  dbStore.policies.push(newPolicy);
  dbStore.persist();

  return res.json({ status: 'sucesso', tenant, policy: newPolicy });
});

// =====================================================================
// Enforcement das demais 5 ações de delegação (EDITAR_CLIENTE, CRIAR_APOLICE, EDITAR_APOLICE,
// CRIAR_COBERTURA_ADICIONAL, EDITAR_COBERTURA_ADICIONAL) — até aqui só CRIAR_CLIENTE (acima) era
// de fato imposto; as demais eram configuráveis na matriz de Permissões (Ponto 6) mas não tinham
// nenhuma rota do lado da corretora que as consumisse. Todas seguem o mesmo formato de resposta
// de POST /clients: 'pendente_aprovacao' quando a matriz/exceção exige aprovação da seguradora,
// ou aplicação direta (via delegatedActions.ts) quando é autônoma.
// =====================================================================

function responderAcaoDelegada(
  res: Response,
  insurerId: string,
  brokerId: string,
  tenantId: string | undefined,
  action: DelegationAction,
  payload: Record<string, any>
) {
  const resolucao = resolveRequiresApproval(insurerId, brokerId, tenantId, action);
  if (resolucao.blocked) {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'A autonomia da corretora para este segurado foi bloqueada pela seguradora (exceção por segurado).'
    });
  }

  if (resolucao.requiresApproval) {
    const approvalRequest = criarApprovalRequest(insurerId, brokerId, action, payload);
    return res.json({
      status: 'pendente_aprovacao',
      mensagem: 'Esta ação exige aprovação da seguradora. Sua solicitação foi registrada e ficará pendente até ser analisada.',
      approval_request: approvalRequest
    });
  }

  const resultado = aplicarAcaoDelegada(action, insurerId, brokerId, payload);
  if (!resultado.ok) {
    const httpStatus = resultado.codigo === 'nao_encontrado' ? 404 : resultado.codigo === 'conflito' ? 409 : 400;
    return res.status(httpStatus).json({ ...resultado, status: resultado.codigo });
  }
  return res.json({ status: 'sucesso', ...resultado });
}

// --- Editar Cliente (segurado) já existente na carteira ---
router.put('/clients/:tenantId', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { tenantId } = req.params;
  const { insurer_id, razao_social, contato_nome, contato_email, contato_telefone_fixo, contato_celular } = req.body;
  const broker_id = resolveBrokerId(req, res, req.body.broker_id);
  if (!broker_id) return;
  if (!insurer_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'insurer_id é obrigatório.' });
  }

  return responderAcaoDelegada(res, insurer_id, broker_id, tenantId, 'EDITAR_CLIENTE', {
    tenant_id: tenantId,
    razao_social,
    contato_nome,
    contato_email,
    contato_telefone_fixo,
    contato_celular
  });
});

// --- Nova apólice para um segurado JÁ existente na carteira ---
router.post('/policies', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const {
    insurer_id,
    tenant_id,
    co_broker_id,
    assessoria_id,
    ramo,
    numero_apolice,
    lmi,
    vigencia_inicio,
    vigencia_fim,
    permitir_inativo_vencido,
    aceita_averbacao_como_destinatario
  } = req.body;
  const broker_id = resolveBrokerId(req, res, req.body.broker_id);
  if (!broker_id) return;

  if (!insurer_id || !tenant_id || !ramo || !numero_apolice) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_id, tenant_id, ramo e numero_apolice são obrigatórios.'
    });
  }

  return responderAcaoDelegada(res, insurer_id, broker_id, tenant_id, 'CRIAR_APOLICE', {
    tenant_id,
    co_broker_id,
    assessoria_id,
    ramo,
    numero_apolice,
    lmi,
    vigencia_inicio,
    vigencia_fim,
    permitir_inativo_vencido,
    aceita_averbacao_como_destinatario
  });
});

// --- Editar apólice já existente na carteira da corretora ---
router.put('/policies/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const { insurer_id, status, permitir_inativo_vencido, numero_apolice, vigencia_inicio, vigencia_fim, lmi } =
    req.body;
  const broker_id = resolveBrokerId(req, res, req.body.broker_id);
  if (!broker_id) return;
  if (!insurer_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'insurer_id é obrigatório.' });
  }

  const policy = dbStore.policies.find((p) => p.id === id);
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não encontrada.' });
  }
  if (policy.broker_id !== broker_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta apólice não pertence à carteira desta corretora.' });
  }

  return responderAcaoDelegada(res, insurer_id, broker_id, policy.tenant_id, 'EDITAR_APOLICE', {
    policy_id: id,
    status,
    permitir_inativo_vencido,
    numero_apolice,
    vigencia_inicio,
    vigencia_fim,
    lmi
  });
});

// --- Ativar Cobertura Adicional (com valor real) numa apólice da carteira ---
router.post('/coverages', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { insurer_id, policy_id, insurer_coverage_id, valor, desconta_lmi } = req.body;
  const broker_id = resolveBrokerId(req, res, req.body.broker_id);
  if (!broker_id) return;
  if (!insurer_id || !policy_id || !insurer_coverage_id) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_id, policy_id e insurer_coverage_id são obrigatórios.'
    });
  }

  const policy = dbStore.policies.find((p) => p.id === policy_id);
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não encontrada.' });
  }
  if (policy.broker_id !== broker_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta cobertura não pertence à carteira desta corretora.' });
  }

  return responderAcaoDelegada(res, insurer_id, broker_id, policy.tenant_id, 'CRIAR_COBERTURA_ADICIONAL', {
    policy_id,
    insurer_coverage_id,
    valor,
    desconta_lmi
  });
});

// --- Editar valor de uma Cobertura Adicional já ativada numa apólice da carteira ---
router.put('/coverages/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const { insurer_id, valor, desconta_lmi } = req.body;
  const broker_id = resolveBrokerId(req, res, req.body.broker_id);
  if (!broker_id) return;
  if (!insurer_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'insurer_id é obrigatório.' });
  }

  const coverageValue = dbStore.policyCoverageValues.find((v) => v.id === id);
  if (!coverageValue) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura ativada não encontrada.' });
  }
  const policy = dbStore.policies.find((p) => p.id === coverageValue.policy_id);
  if (!policy || policy.broker_id !== broker_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta cobertura não pertence à carteira desta corretora.' });
  }

  return responderAcaoDelegada(res, insurer_id, broker_id, policy.tenant_id, 'EDITAR_COBERTURA_ADICIONAL', {
    id,
    valor,
    desconta_lmi
  });
});

// --- Relatório escopado à carteira da corretora ---
router.get('/relatorio', requirePermission('relatorios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { insurer_id } = req.query;
  const broker_id = resolveBrokerId(req, res, req.query.broker_id);
  if (!broker_id) return;

  let policies = dbStore.policies.filter((p) => p.broker_id === broker_id);
  if (insurer_id) policies = policies.filter((p) => p.insurer_id === insurer_id);
  const tenantIds = Array.from(new Set(policies.map((p) => p.tenant_id)));

  const porCliente = tenantIds.map((tenantId) => {
    const tenant = dbStore.tenants.find((t) => t.id === tenantId);
    const policyIdsDoCliente = new Set(policies.filter((p) => p.tenant_id === tenantId).map((p) => p.id));
    const averbacoesDoCliente = dbStore.averbacoes.filter((a) => policyIdsDoCliente.has(a.policy_id));
    const sucesso = averbacoesDoCliente.filter((a) => a.status === 'SUCESSO');
    const erro = averbacoesDoCliente.filter((a) => a.status === 'ERRO');

    return {
      tenant_id: tenantId,
      razao_social: tenant?.razao_social || 'Cliente não encontrado',
      cnpj: tenant?.cnpj || '-',
      total_averbacoes: averbacoesDoCliente.length,
      total_sucesso: sucesso.length,
      total_erro: erro.length,
      valor_total_averbado: sucesso.reduce((acc, a) => acc + (a.valor_considerado_averbacao || a.valor_carga || 0), 0)
    };
  });

  return res.json({ status: 'sucesso', por_cliente: porCliente });
});

export default router;
