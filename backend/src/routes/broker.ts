import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Tenant, Policy, DelegationAction } from '../types';

const router = Router();

/**
 * Todas as rotas aqui são escopadas por broker_id (a corretora) e, opcionalmente,
 * insurer_id (para restringir à carteira de uma seguradora específica). Uma corretora
 * NUNCA enxerga a carteira de outra corretora, mesmo que atendam à mesma seguradora.
 */

// --- Carteira de Clientes da Corretora ---
router.get('/clients', (req, res) => {
  const { broker_id, insurer_id } = req.query;
  if (!broker_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'broker_id é obrigatório.' });
  }

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
router.get('/averbacoes', (req, res) => {
  const { broker_id, insurer_id, apenas_recusadas } = req.query;
  if (!broker_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'broker_id é obrigatório.' });
  }

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
router.post('/clients', (req, res) => {
  const {
    insurer_id,
    broker_id,
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

  if (!insurer_id || !broker_id || !cnpj || !razao_social || !ramo || !numero_apolice) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_id, broker_id, cnpj, razao_social, ramo e numero_apolice são obrigatórios.'
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

// --- Relatório escopado à carteira da corretora ---
router.get('/relatorio', (req, res) => {
  const { broker_id, insurer_id } = req.query;
  if (!broker_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'broker_id é obrigatório.' });
  }

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
