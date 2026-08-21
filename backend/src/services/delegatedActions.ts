import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import { DelegationAction, Tenant, Policy, ApprovalRequest, PolicyCoverageValue } from '../types';

/**
 * Serviço compartilhado de ações delegadas da corretora (Permissões e Autonomia).
 *
 * Centraliza em um único lugar:
 * 1) `resolveRequiresApproval` — cruza a matriz geral (DelegationPermission, por ação) com a
 *    exceção por segurado (DelegationException, quando há tenant_id) para decidir se uma ação
 *    exige aprovação da seguradora, é autônoma, ou está bloqueada.
 * 2) `aplicarAcaoDelegada` — a mutação real de cada uma das 6 ações de delegação. É chamada em
 *    dois pontos: (a) direto, quando a ação não exige aprovação; (b) por
 *    `POST /admin/approval-requests/:id/resolve`, quando uma solicitação pendente é aprovada —
 *    antes desta rodada, aprovar uma solicitação só mudava o status, sem nunca executar a ação
 *    de fato. Isso valia até para CRIAR_CLIENTE, que por isso teve sua lógica de aplicação
 *    duplicada aqui (a rota original em broker.ts não foi alterada, para não arriscar regressão
 *    em um fluxo já validado — mas agora o resolve também sabe aplicá-la de verdade).
 */

export interface ResolvedApproval {
  /** true quando a exceção do segurado bloqueia a ação por completo (nem direto, nem aprovação). */
  blocked: boolean;
  requiresApproval: boolean;
}

export function resolveRequiresApproval(
  insurerId: string,
  brokerId: string,
  tenantId: string | undefined,
  action: DelegationAction
): ResolvedApproval {
  if (tenantId) {
    const exception = dbStore.delegationExceptions.find(
      (e) => e.insurer_id === insurerId && e.broker_id === brokerId && e.tenant_id === tenantId
    );
    if (exception) {
      if (exception.nivel === 'BLOQUEADA') return { blocked: true, requiresApproval: true };
      if (exception.nivel === 'AUTONOMO') return { blocked: false, requiresApproval: false };
      if (exception.nivel === 'MEDIANTE_APROVACAO') return { blocked: false, requiresApproval: true };
    }
  }

  const delegation = dbStore.delegationPermissions.find(
    (d) => d.insurer_id === insurerId && d.broker_id === brokerId && d.action === action
  );
  // Mesmo padrão já usado em broker.ts (CRIAR_CLIENTE): sem configuração explícita, exige aprovação.
  return { blocked: false, requiresApproval: delegation ? delegation.requires_approval : true };
}

export function criarApprovalRequest(
  insurerId: string,
  brokerId: string,
  action: DelegationAction,
  payload: Record<string, any>
): ApprovalRequest {
  const approvalRequest: ApprovalRequest = {
    id: uuidv4(),
    insurer_id: insurerId,
    broker_id: brokerId,
    action,
    payload,
    status: 'PENDENTE',
    created_at: new Date().toISOString()
  };
  dbStore.approvalRequests.push(approvalRequest);
  dbStore.persist();
  return approvalRequest;
}

type AplicarResultado =
  | { ok: true; [key: string]: any }
  | { ok: false; codigo: 'conflito' | 'nao_encontrado' | 'erro'; mensagem: string; [key: string]: any };

// --- CRIAR_CLIENTE (mesma lógica de POST /broker/clients, duplicada para o fluxo de aprovação) ---
function aplicarCriarCliente(insurerId: string, brokerId: string, payload: Record<string, any>): AplicarResultado {
  const {
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
  } = payload;

  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  let tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpjLimpo);

  if (tenant) {
    const policyConflitante = dbStore.policies.find(
      (p) => p.tenant_id === tenant!.id && p.ramo === ramo && p.status === 'ATIVA' && p.insurer_id !== insurerId
    );
    if (policyConflitante) {
      return {
        ok: false,
        codigo: 'conflito',
        mensagem: `Já existe uma apólice ativa do ramo ${ramo} para este CNPJ vinculada a outra seguradora.`,
        tenant_id: tenant.id,
        ramo
      };
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
    insurer_id: insurerId,
    broker_id: brokerId,
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

  return { ok: true, tenant, policy: newPolicy };
}

// --- EDITAR_CLIENTE — campos cadastrais/contato do segurado (não inclui status/ambiente/cnpj,
// que seguem exclusivos do Portal ARCKATECH via /admin/tenants/:id) ---
function aplicarEditarCliente(payload: Record<string, any>): AplicarResultado {
  const { tenant_id, razao_social, contato_nome, contato_email, contato_telefone_fixo, contato_celular } = payload;
  const tenant = dbStore.tenants.find((t) => t.id === tenant_id);
  if (!tenant) {
    return { ok: false, codigo: 'nao_encontrado', mensagem: 'Segurado não encontrado.' };
  }

  if (razao_social !== undefined) tenant.razao_social = razao_social;
  if (contato_nome !== undefined) tenant.contato_nome = contato_nome;
  if (contato_email !== undefined) tenant.contato_email = contato_email;
  if (contato_telefone_fixo !== undefined) tenant.contato_telefone_fixo = contato_telefone_fixo;
  if (contato_celular !== undefined) tenant.contato_celular = contato_celular;

  dbStore.persist();
  return { ok: true, tenant };
}

// --- CRIAR_APOLICE — nova apólice para um segurado JÁ existente (tenant_id obrigatório;
// diferente de CRIAR_CLIENTE, que também cria o tenant quando não existe) ---
function aplicarCriarApolice(insurerId: string, brokerId: string, payload: Record<string, any>): AplicarResultado {
  const {
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
  } = payload;

  const tenant = dbStore.tenants.find((t) => t.id === tenant_id);
  if (!tenant) {
    return { ok: false, codigo: 'nao_encontrado', mensagem: 'Segurado não encontrado.' };
  }

  const policyConflitante = dbStore.policies.find(
    (p) => p.tenant_id === tenant_id && p.ramo === ramo && p.status === 'ATIVA' && p.insurer_id !== insurerId
  );
  if (policyConflitante) {
    return {
      ok: false,
      codigo: 'conflito',
      mensagem: `Já existe uma apólice ativa do ramo ${ramo} para este segurado vinculada a outra seguradora.`,
      tenant_id,
      ramo
    };
  }

  const newPolicy: Policy = {
    id: `pol_${String(ramo).toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id,
    insurer_id: insurerId,
    broker_id: brokerId,
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

  return { ok: true, tenant, policy: newPolicy };
}

// --- EDITAR_APOLICE — campos operacionais (não permite trocar ramo/insurer_id/broker_id: isso
// é reatribuição de carteira, mantido exclusivo do Portal ARCKATECH via /admin/policies/:id) ---
function aplicarEditarApolice(payload: Record<string, any>): AplicarResultado {
  const { policy_id, status, permitir_inativo_vencido, numero_apolice, vigencia_inicio, vigencia_fim, lmi } = payload;
  const policy = dbStore.policies.find((p) => p.id === policy_id);
  if (!policy) {
    return { ok: false, codigo: 'nao_encontrado', mensagem: 'Apólice não encontrada.' };
  }

  if (status !== undefined) policy.status = status;
  if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
  if (numero_apolice !== undefined) policy.numero_apolice = numero_apolice;
  if (vigencia_inicio !== undefined) policy.vigencia_inicio = vigencia_inicio;
  if (vigencia_fim !== undefined) policy.vigencia_fim = vigencia_fim;
  if (lmi !== undefined) policy.lmi = lmi === null || lmi === '' ? undefined : Number(lmi);

  dbStore.persist();
  return { ok: true, policy };
}

// --- CRIAR_COBERTURA_ADICIONAL — ativa uma InsurerCoverage numa apólice específica com valor real ---
function aplicarCriarCobertura(payload: Record<string, any>): AplicarResultado {
  const { policy_id, insurer_coverage_id, valor, desconta_lmi } = payload;
  const policy = dbStore.policies.find((p) => p.id === policy_id);
  if (!policy) {
    return { ok: false, codigo: 'nao_encontrado', mensagem: 'Apólice não encontrada.' };
  }
  const coverage = dbStore.insurerCoverages.find((c) => c.id === insurer_coverage_id);
  if (!coverage) {
    return { ok: false, codigo: 'nao_encontrado', mensagem: 'Cobertura adicional não encontrada.' };
  }

  const existente = dbStore.policyCoverageValues.find(
    (v) => v.policy_id === policy_id && v.insurer_coverage_id === insurer_coverage_id
  );
  if (existente) {
    return {
      ok: false,
      codigo: 'conflito',
      mensagem: 'Esta cobertura já está ativada nesta apólice. Use a edição para alterar o valor.'
    };
  }

  const now = new Date().toISOString();
  const newValue: PolicyCoverageValue = {
    id: uuidv4(),
    policy_id,
    insurer_coverage_id,
    valor: Number(valor) || 0,
    desconta_lmi: Boolean(desconta_lmi),
    created_at: now,
    updated_at: now
  };
  dbStore.policyCoverageValues.push(newValue);
  dbStore.persist();
  return { ok: true, coverage_value: newValue };
}

// --- EDITAR_COBERTURA_ADICIONAL — altera valor/desconta_lmi de uma cobertura já ativada ---
function aplicarEditarCobertura(payload: Record<string, any>): AplicarResultado {
  const { id, valor, desconta_lmi } = payload;
  const value = dbStore.policyCoverageValues.find((v) => v.id === id);
  if (!value) {
    return { ok: false, codigo: 'nao_encontrado', mensagem: 'Cobertura ativada não encontrada nesta apólice.' };
  }

  if (valor !== undefined) value.valor = Number(valor) || 0;
  if (desconta_lmi !== undefined) value.desconta_lmi = Boolean(desconta_lmi);
  value.updated_at = new Date().toISOString();

  dbStore.persist();
  return { ok: true, coverage_value: value };
}

/**
 * Ponto único de aplicação — usado tanto pelas rotas de broker.ts (quando a ação não exige
 * aprovação) quanto por `POST /admin/approval-requests/:id/resolve` (quando uma solicitação é
 * aprovada). `insurerId`/`brokerId` vêm sempre do próprio ApprovalRequest/contexto da rota, nunca
 * do payload — evita que o payload arbitrário sobrescreva o escopo de carteira.
 */
export function aplicarAcaoDelegada(
  action: DelegationAction,
  insurerId: string,
  brokerId: string,
  payload: Record<string, any>
): AplicarResultado {
  switch (action) {
    case 'CRIAR_CLIENTE':
      return aplicarCriarCliente(insurerId, brokerId, payload);
    case 'EDITAR_CLIENTE':
      return aplicarEditarCliente(payload);
    case 'CRIAR_APOLICE':
      return aplicarCriarApolice(insurerId, brokerId, payload);
    case 'EDITAR_APOLICE':
      return aplicarEditarApolice(payload);
    case 'CRIAR_COBERTURA_ADICIONAL':
      return aplicarCriarCobertura(payload);
    case 'EDITAR_COBERTURA_ADICIONAL':
      return aplicarEditarCobertura(payload);
    default:
      return { ok: false, codigo: 'erro', mensagem: `Ação de delegação desconhecida: ${action}.` };
  }
}
