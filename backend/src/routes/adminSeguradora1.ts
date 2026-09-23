import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Tenant, Policy, InsurerCoverage, RbacProfile, TenantUser, DelegationException, DelegationExceptionLevel } from '../types';
import { PurgeService } from '../services/purgeService';
import { sendActivationInviteEmail } from '../services/emailService';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';
import { resolveInsurerId, apenasInternalUser } from './adminHelpers';
import { seedPartnerHistory } from './adminPacote2109';

/**
 * Segunda parte de admin.ts (seções 10 a H) — extraída para arquivo próprio só por tamanho, ver
 * comentário em adminHelpers.ts. Mesmo prefixo /api/v1/admin (montada via
 * `router.use('/', adminSeguradora1Router)` em admin.ts).
 */
const router = Router();

// --- 10. EXPURGO AUTOMÁTICO DE DADOS DE TESTE ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna, exclusiva de ADM.
router.post('/expurgo', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { dias } = req.body;
  const result = PurgeService.purgeTestData(Number(dias || 30));
  return res.json({ status: 'sucesso', result });
});

// --- 11. RELATÓRIO POR CLIENTE OU CONJUNTO DE CLIENTES ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM (o
// relatório não é escopado por insurer_id, então não pode ser aberto para SEGURADORA sem
// filtragem — ver Backlog para essa decisão futura, se algum dia for exposto no portal).
router.get('/relatorio', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_ids } = req.query;

  const ids = tenant_ids
    ? String(tenant_ids).split(',').filter(Boolean)
    : dbStore.tenants.map((t) => t.id);

  const porCliente = ids.map((tenantId) => {
    const tenant = dbStore.tenants.find((t) => t.id === tenantId);
    const averbacoesDoCliente = dbStore.averbacoes.filter((a) => a.tenant_id === tenantId);
    const sucesso = averbacoesDoCliente.filter((a) => a.status === 'SUCESSO');
    const erro = averbacoesDoCliente.filter((a) => a.status === 'ERRO');
    const valorTotal = sucesso.reduce((acc, a) => acc + (a.valor_carga || 0), 0);

    return {
      tenant_id: tenantId,
      razao_social: tenant?.razao_social || 'Cliente não encontrado',
      cnpj: tenant?.cnpj || '-',
      total_averbacoes: averbacoesDoCliente.length,
      total_sucesso: sucesso.length,
      total_erro: erro.length,
      valor_total_averbado: valorTotal,
      por_tipo_documento: {
        CTE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'CTE').length,
        NFE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'NFE').length,
        NFSE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'NFSE').length,
        MDFE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'MDFE').length
      }
    };
  });

  const consolidado = {
    total_averbacoes: porCliente.reduce((acc, c) => acc + c.total_averbacoes, 0),
    total_sucesso: porCliente.reduce((acc, c) => acc + c.total_sucesso, 0),
    total_erro: porCliente.reduce((acc, c) => acc + c.total_erro, 0),
    valor_total_averbado: porCliente.reduce((acc, c) => acc + c.valor_total_averbado, 0)
  };

  return res.json({ status: 'sucesso', consolidado, por_cliente: porCliente });
});

// --- 12. DOCUMENTAÇÃO DA API (serve o Markdown de referência de cada endpoint) ---
// Sem consumidor no Portal da Seguradora hoje — referência técnica interna, exclusiva de ADM.
router.get('/docs', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  try {
    const docPath = path.join(__dirname, '../../docs/API_DOCUMENTATION.md');
    const content = fs.readFileSync(docPath, 'utf-8');
    return res.json({ status: 'sucesso', content });
  } catch (err: any) {
    return res.status(500).json({ status: 'erro', mensagem: 'Documentação não encontrada no servidor.' });
  }
});

// Dashboard Analytics — visão GLOBAL (todas as seguradoras somadas), uso interno ARCKATECH.
// Distinto de /insurer-dashboard-stats (abaixo), que é escopado por insurer_id e é o que o
// Portal da Seguradora de fato consome.
router.get('/dashboard-stats', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const totalClientes = dbStore.tenants.length;
  const clientesTeste = dbStore.tenants.filter((t) => t.ambiente === 'teste').length;
  const clientesProd = dbStore.tenants.filter((t) => t.ambiente === 'producao').length;

  const totalAverbacoes = dbStore.averbacoes.length;
  const averbacoesProd = dbStore.averbacoes.filter((a) => a.ambiente === 'producao').length;
  const averbacoesTeste = dbStore.averbacoes.filter((a) => a.ambiente === 'teste').length;

  const totalApolices = dbStore.policies.length;

  return res.json({
    status: 'sucesso',
    stats: {
      totalClientes,
      clientesTeste,
      clientesProd,
      totalAverbacoes,
      averbacoesProd,
      averbacoesTeste,
      totalApolices
    }
  });
});

// =====================================================================
// FASE 2 — ENDPOINTS DE SEGURADORA
// =====================================================================

// --- A. Lookup de CNPJ com visibilidade mínima (só números de ramo vigentes) ---
router.get('/tenants/lookup', (req, res) => {
  const cnpj = String(req.query.cnpj || '').replace(/\D/g, '');
  if (!cnpj) {
    return res.status(400).json({ status: 'erro', mensagem: 'Informe o CNPJ para consulta.' });
  }

  const tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpj);
  if (!tenant) {
    return res.json({ status: 'sucesso', encontrado: false, ramos_vigentes: [] });
  }

  const ramosVigentes = Array.from(
    new Set(
      dbStore.policies
        .filter((p) => p.tenant_id === tenant.id && p.status === 'ATIVA')
        .map((p) => p.ramo)
    )
  );

  // Visibilidade mínima: nunca retornar insurer_id, broker_id, valores ou qualquer outro dado.
  return res.json({ status: 'sucesso', encontrado: true, ramos_vigentes: ramosVigentes });
});

// URL pública do Portal do Segurado, usada para montar o link do e-mail de convite abaixo.
// PUBLIC_APP_URL já é a variável documentada em .env.production.example para "a URL pública do
// app"; localhost:5173 como fallback cobre o dev local do arckatech-cargo-portal (vite dev).
function portalSeguradoBaseUrl(): string {
  return process.env.PUBLIC_APP_URL || 'http://localhost:5173';
}

/**
 * Gera um novo ActivationToken de convite (Termo de Uso + primeira senha) para o tenant, e tenta
 * enviar o e-mail via Resend — usado tanto na criação de um cliente novo (POST /insurer-clients)
 * quanto no reenvio manual (POST /insurer-clients/:tenantId/reenviar-convite, abaixo). Nunca
 * lança: se o e-mail não puder ser enviado, devolve o motivo para quem chamou decidir o que
 * mostrar na tela (o convite/token continua criado e válido de qualquer forma — só o e-mail
 * automático que pode ter falhado).
 */
async function criarEEnviarConvite(
  tenant: Tenant,
  nomeConvidado: string | undefined,
  emailConvidado: string | undefined
): Promise<{ enviado: boolean; destino?: string; motivo?: string }> {
  const activationToken = {
    id: uuidv4(),
    tenant_id: tenant.id,
    token: `act_${uuidv4()}`,
    termo_versao: 'v1',
    aceite: false,
    expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    convite_nome: nomeConvidado,
    convite_email: emailConvidado
  };
  dbStore.activationTokens.push(activationToken);
  dbStore.persist();

  const destino = (emailConvidado || tenant.contato_email || '').trim();
  if (!destino) {
    return { enviado: false, motivo: 'Nenhum e-mail de contato informado para este cliente.' };
  }

  const resultado = await sendActivationInviteEmail({
    to: destino,
    nomeDestinatario: nomeConvidado || tenant.contato_nome || tenant.razao_social,
    razaoSocial: tenant.razao_social,
    activationUrl: `${portalSeguradoBaseUrl()}/ativacao/${activationToken.token}`
  });

  return { ...resultado, destino };
}

// --- B. Cadastro de Cliente pela Seguradora (cria tenant + apólice, ou detecta conflito) ---
router.post('/insurer-clients', requirePermission('clientes', 'editar'), async (req: BackofficeAuthenticatedRequest, res) => {
  const {
    broker_id,
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
    contato_celular,
    logradouro,
    numero_endereco,
    bairro,
    cidade,
    uf,
    cep,
    codigo_interno_seguradora,
    // Fase 1 do pacote de 21/09 — array opcional [{ cnpj, tipo }], persistido de verdade a
    // partir de agora (achado do relatório de 20/09: antes era descartado silenciosamente).
    cnpjs_adicionais
  } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  if (!broker_id || !cnpj || !razao_social || !ramo || !numero_apolice) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'broker_id, cnpj, razao_social, ramo e numero_apolice são obrigatórios.'
    });
  }

  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  let tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpjLimpo);
  let clienteNovo = false;

  if (tenant) {
    // Cliente já existe — checar conflito de ramo com OUTRA seguradora
    const policyConflitante = dbStore.policies.find(
      (p) => p.tenant_id === tenant!.id && p.ramo === ramo && p.status === 'ATIVA' && p.insurer_id !== insurer_id
    );

    if (policyConflitante) {
      return res.status(409).json({
        status: 'conflito',
        mensagem: `Já existe uma apólice ativa do ramo ${ramo} para este CNPJ vinculada a outra seguradora.`,
        tenant_id: tenant.id,
        ramo,
        instrucao: 'Use POST /admin/insurer-clients/:tenantId/assume-policy para assumir a responsabilidade desta apólice.'
      });
    }

    const jaTemEsseRamoComEstaSeguradora = dbStore.policies.some(
      (p) => p.tenant_id === tenant!.id && p.ramo === ramo && p.insurer_id === insurer_id
    );
    if (jaTemEsseRamoComEstaSeguradora) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Este cliente já possui uma apólice deste ramo com esta seguradora.'
      });
    }
  } else {
    // Cliente novo — cria o tenant
    clienteNovo = true;
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
      nome_fantasia,
      logradouro,
      numero_endereco,
      bairro,
      cidade,
      uf,
      cep,
      conta_ativada: false
    };
    dbStore.tenants.push(tenant);
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
    aceita_averbacao_como_destinatario: Boolean(aceita_averbacao_como_destinatario),
    codigo_interno_seguradora: codigo_interno_seguradora || undefined
  };
  dbStore.policies.push(newPolicy);
  seedPartnerHistory(newPolicy);

  if (Array.isArray(cnpjs_adicionais)) {
    for (const item of cnpjs_adicionais) {
      if (!item?.cnpj || (item.tipo !== 'filial' && item.tipo !== 'adicional')) continue;
      const cnpjItemLimpo = String(item.cnpj).replace(/\D/g, '');
      const jaExiste = dbStore.tenantCnpjsAdicionais.some(
        (c) => c.tenant_id === tenant!.id && c.cnpj.replace(/\D/g, '') === cnpjItemLimpo
      );
      if (jaExiste) continue;
      dbStore.tenantCnpjsAdicionais.push({
        id: uuidv4(),
        tenant_id: tenant.id,
        cnpj: item.cnpj,
        tipo: item.tipo,
        status: 'ATIVO',
        created_at: new Date().toISOString()
      });
    }
  }

  dbStore.persist();

  // Convite por e-mail (Termo de Uso + primeira senha) só é disparado na criação do cliente —
  // um cliente já existente que ganha mais uma apólice/ramo não deve receber um novo convite
  // toda vez (senão a pessoa recebe um e-mail de "defina sua senha" repetido a cada apólice nova).
  let convite: { enviado: boolean; destino?: string; motivo?: string } | undefined;
  if (clienteNovo) {
    convite = await criarEEnviarConvite(tenant, contato_nome, contato_email);
  }

  return res.json({ status: 'sucesso', tenant, policy: newPolicy, convite });
});

/**
 * POST /admin/insurer-clients/:tenantId/reenviar-convite
 * Gera um novo convite (Termo de Uso + primeira senha) e tenta reenviar o e-mail — para quando o
 * primeiro convite expirou (30 dias), foi perdido/caiu em spam, ou o e-mail de contato mudou.
 * O corpo aceita um `email` opcional para reenviar a um endereço diferente do cadastrado.
 */
router.post('/insurer-clients/:tenantId/reenviar-convite', requirePermission('clientes', 'editar'), async (req: BackofficeAuthenticatedRequest, res) => {
  const { tenantId } = req.params;
  const { email } = req.body as { email?: string };

  const tenant = dbStore.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });
  }
  // Este tenant não tem insurer_id direto — pertencimento é verificado via as apólices que o
  // ligam a uma seguradora (mesma lógica de GET /tenants acima).
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA') {
    const pertence = dbStore.policies.some((p) => p.tenant_id === tenantId && p.insurer_id === ator.insurer_id);
    if (!pertence) {
      return res.status(403).json({ status: 'erro', mensagem: 'Este cliente não pertence à sua seguradora.' });
    }
  } else if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  if (tenant.conta_ativada) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Este cliente já ativou a conta. Não há convite pendente para reenviar.'
    });
  }

  const convite = await criarEEnviarConvite(tenant, tenant.contato_nome, email || tenant.contato_email);
  return res.json({ status: 'sucesso', convite });
});

// --- C. Assumir Apólice em Conflito ---
router.post('/insurer-clients/:tenantId/assume-policy', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { tenantId } = req.params;
  const { broker_id, ramo, numero_apolice, lmi, vigencia_inicio, vigencia_fim, permitir_inativo_vencido, aceita_averbacao_como_destinatario } =
    req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  const policy = dbStore.policies.find((p) => p.tenant_id === tenantId && p.ramo === ramo && p.status === 'ATIVA');
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Nenhuma apólice ativa encontrada para este cliente/ramo.' });
  }

  policy.insurer_id = insurer_id;
  policy.broker_id = broker_id;
  if (numero_apolice) policy.numero_apolice = numero_apolice;
  if (lmi !== undefined) policy.lmi = Number(lmi);
  if (vigencia_inicio) policy.vigencia_inicio = vigencia_inicio;
  if (vigencia_fim) policy.vigencia_fim = vigencia_fim;
  if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
  if (aceita_averbacao_como_destinatario !== undefined) {
    policy.aceita_averbacao_como_destinatario = Boolean(aceita_averbacao_como_destinatario);
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

// --- D. Coberturas Adicionais da Seguradora (insurer_coverages) ---
router.get('/insurer-coverages', requirePermission('coberturas', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const insurer_id = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurer_id) return;
  const items = dbStore.insurerCoverages.filter((c) => c.insurer_id === insurer_id);
  return res.json({ status: 'sucesso', coverages: items });
});

router.post('/insurer-coverages', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { ramo, titulo, exemplo_preenchimento, obrigatoria, aplicar_todos_clientes, tenant_id, tipo_valor } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  if (!titulo) {
    return res.status(400).json({ status: 'erro', mensagem: 'titulo é obrigatório.' });
  }
  if (aplicar_todos_clientes === false && !tenant_id) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'tenant_id é obrigatório quando aplicar_todos_clientes for false.'
    });
  }

  const newCoverage: InsurerCoverage = {
    id: uuidv4(),
    insurer_id,
    ramo,
    titulo,
    exemplo_preenchimento,
    obrigatoria: Boolean(obrigatoria),
    aplicar_todos_clientes: aplicar_todos_clientes !== false,
    tenant_id: aplicar_todos_clientes === false ? tenant_id : undefined,
    tipo_valor: tipo_valor === 'monetario' ? 'monetario' : 'informativo',
    created_at: new Date().toISOString()
  };

  dbStore.insurerCoverages.push(newCoverage);
  dbStore.persist();
  return res.json({ status: 'sucesso', coverage: newCoverage });
});

router.put('/insurer-coverages/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const coverage = dbStore.insurerCoverages.find((c) => c.id === id);
  if (!coverage) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura adicional não encontrada.' });
  }
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && coverage.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta cobertura não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }

  const { ramo, titulo, exemplo_preenchimento, obrigatoria, aplicar_todos_clientes, tenant_id, tipo_valor } = req.body;
  if (ramo !== undefined) coverage.ramo = ramo;
  if (titulo !== undefined) coverage.titulo = titulo;
  if (exemplo_preenchimento !== undefined) coverage.exemplo_preenchimento = exemplo_preenchimento;
  if (obrigatoria !== undefined) coverage.obrigatoria = Boolean(obrigatoria);
  if (aplicar_todos_clientes !== undefined) coverage.aplicar_todos_clientes = Boolean(aplicar_todos_clientes);
  if (tenant_id !== undefined) coverage.tenant_id = tenant_id;
  if (tipo_valor !== undefined) coverage.tipo_valor = tipo_valor === 'monetario' ? 'monetario' : 'informativo';

  dbStore.persist();
  return res.json({ status: 'sucesso', coverage });
});

router.delete('/insurer-coverages/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const coverage = dbStore.insurerCoverages.find((c) => c.id === id);
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && coverage && coverage.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta cobertura não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  dbStore.insurerCoverages = dbStore.insurerCoverages.filter((c) => c.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Cobertura adicional removida com sucesso.' });
});

// --- E. Manutenção em Massa de Apólices ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna, exclusiva de ADM (não filtra
// por insurer_id, então não pode ser aberta para SEGURADORA sem checar cada policy_id antes).
router.post('/policies/bulk-update', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { policy_ids, updates } = req.body;

  if (!Array.isArray(policy_ids) || policy_ids.length === 0) {
    return res.status(400).json({ status: 'erro', mensagem: 'Informe ao menos um policy_id em policy_ids.' });
  }

  const { lmi, vigencia_inicio, vigencia_fim, permitir_inativo_vencido } = updates || {};
  let atualizadas = 0;

  for (const policy of dbStore.policies) {
    if (!policy_ids.includes(policy.id)) continue;
    if (lmi !== undefined) policy.lmi = Number(lmi);
    if (vigencia_inicio !== undefined) policy.vigencia_inicio = vigencia_inicio;
    if (vigencia_fim !== undefined) policy.vigencia_fim = vigencia_fim;
    if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
    atualizadas++;
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', total_atualizadas: atualizadas });
});

// --- F. Perfis de Acesso (RBAC) ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/rbac-profiles', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { owner_type, owner_id } = req.query;
  let items = dbStore.rbacProfiles;
  if (owner_type) items = items.filter((p) => p.owner_type === owner_type);
  if (owner_id) items = items.filter((p) => p.owner_id === owner_id);
  return res.json({ status: 'sucesso', profiles: items });
});

router.post('/rbac-profiles', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { owner_type, owner_id, nome_perfil, permissions } = req.body;
  if (!owner_type || !nome_perfil || !permissions) {
    return res.status(400).json({ status: 'erro', mensagem: 'owner_type, nome_perfil e permissions são obrigatórios.' });
  }

  const newProfile: RbacProfile = {
    id: uuidv4(),
    owner_type,
    owner_id,
    nome_perfil,
    permissions,
    created_at: new Date().toISOString()
  };
  dbStore.rbacProfiles.push(newProfile);
  dbStore.persist();
  return res.json({ status: 'sucesso', profile: newProfile });
});

router.put('/rbac-profiles/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const profile = dbStore.rbacProfiles.find((p) => p.id === id);
  if (!profile) {
    return res.status(404).json({ status: 'erro', mensagem: 'Perfil de acesso não encontrado.' });
  }
  const { nome_perfil, permissions } = req.body;
  if (nome_perfil !== undefined) profile.nome_perfil = nome_perfil;
  if (permissions !== undefined) profile.permissions = permissions;
  dbStore.persist();
  return res.json({ status: 'sucesso', profile });
});

router.delete('/rbac-profiles/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  dbStore.rbacProfiles = dbStore.rbacProfiles.filter((p) => p.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Perfil de acesso removido com sucesso.' });
});

// --- G. Usuários Internos do Tenant (seguradora/corretora/transportador) ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/tenant-users', requirePermission('usuarios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_id } = req.query;
  let items = dbStore.tenantUsers;
  if (tenant_id) items = items.filter((u) => u.tenant_id === tenant_id);
  const usersSemSenha = items.map(({ password_hash, ...u }) => u);
  return res.json({ status: 'sucesso', users: usersSemSenha });
});

// Mesma lógica de senha temporária usada em POST /tenant/users — mantida em sincronia para que
// um usuário criado por aqui (painel admin interno da Arckatech) também consiga logar depois em
// POST /auth/portal-login. Não há envio de e-mail integrado: a senha em texto plano é devolvida
// UMA ÚNICA VEZ na resposta deste POST.
function gerarSenhaTemporaria(): string {
  return crypto.randomBytes(9).toString('base64url');
}

router.post('/tenant-users', requirePermission('usuarios', 'editar'), async (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_id, nome, email, rbac_profile_id, is_admin_da_conta } = req.body;
  if (!tenant_id || !nome || !email) {
    return res.status(400).json({ status: 'erro', mensagem: 'tenant_id, nome e email são obrigatórios.' });
  }

  const senhaTemporaria = gerarSenhaTemporaria();
  const passwordHash = await bcrypt.hash(senhaTemporaria, 10);

  const newUser: TenantUser = {
    id: uuidv4(),
    tenant_id,
    nome,
    email,
    password_hash: passwordHash,
    rbac_profile_id,
    is_admin_da_conta: Boolean(is_admin_da_conta),
    status: 'ATIVO',
    created_at: new Date().toISOString()
  };
  dbStore.tenantUsers.push(newUser);
  dbStore.persist();

  const { password_hash, ...userSemSenha } = newUser;
  return res.json({ status: 'sucesso', user: userSemSenha, senha_temporaria: senhaTemporaria });
});

router.put('/tenant-users/:id', requirePermission('usuarios', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const user = dbStore.tenantUsers.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado.' });
  }
  const { nome, email, rbac_profile_id, status, is_admin_da_conta } = req.body;
  if (nome !== undefined) user.nome = nome;
  if (email !== undefined) user.email = email;
  if (rbac_profile_id !== undefined) user.rbac_profile_id = rbac_profile_id;
  if (status !== undefined) user.status = status;
  if (is_admin_da_conta !== undefined) user.is_admin_da_conta = Boolean(is_admin_da_conta);
  dbStore.persist();
  const { password_hash, ...userSemSenha } = user;
  return res.json({ status: 'sucesso', user: userSemSenha });
});

router.delete('/tenant-users/:id', requirePermission('usuarios', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  dbStore.tenantUsers = dbStore.tenantUsers.filter((u) => u.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Usuário removido com sucesso.' });
});

// --- H. Delegação de Poder Seguradora → Corretora ---
// insurer_id aqui é filtro opcional para ADM (preserva o comportamento de antes: sem informar,
// lista de todas as seguradoras) — só é obrigatório e forçado pelo token quando quem chama é
// uma SEGURADORA.
router.get('/delegation-permissions', requirePermission('delegacao_corretora', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id } = req.query;
  const ator = req.backoffice;
  let items = dbStore.delegationPermissions;
  if (ator?.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    }
    items = items.filter((d) => d.insurer_id === ator.insurer_id);
  } else if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  } else if (req.query.insurer_id) {
    items = items.filter((d) => d.insurer_id === req.query.insurer_id);
  }
  if (broker_id) items = items.filter((d) => d.broker_id === broker_id);
  return res.json({ status: 'sucesso', permissions: items });
});

router.put('/delegation-permissions', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id, actions } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;
  if (!broker_id || !Array.isArray(actions)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'broker_id e actions (lista de { action, requires_approval }) são obrigatórios.'
    });
  }

  for (const item of actions) {
    const existing = dbStore.delegationPermissions.find(
      (d) => d.insurer_id === insurer_id && d.broker_id === broker_id && d.action === item.action
    );
    if (existing) {
      existing.requires_approval = Boolean(item.requires_approval);
    } else {
      dbStore.delegationPermissions.push({
        id: uuidv4(),
        insurer_id,
        broker_id,
        action: item.action,
        requires_approval: Boolean(item.requires_approval)
      });
    }
  }

  dbStore.persist();
  return res.json({
    status: 'sucesso',
    permissions: dbStore.delegationPermissions.filter((d) => d.insurer_id === insurer_id && d.broker_id === broker_id)
  });
});

// --- Exceções por Segurado (override da matriz de delegação para um tenant específico dentro
// da carteira de uma corretora) — aba "Exceções por segurado" em Permissões e Autonomia. ---
router.get('/delegation-exceptions', requirePermission('delegacao_corretora', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id } = req.query;
  const insurer_id = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurer_id) return;
  if (!broker_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'broker_id é obrigatório.' });
  }
  const items = dbStore.delegationExceptions.filter((e) => e.insurer_id === insurer_id && e.broker_id === broker_id);
  return res.json({ status: 'sucesso', exceptions: items });
});

router.put('/delegation-exceptions', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id, tenant_id, nivel } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;
  if (!broker_id || !tenant_id || !nivel) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'broker_id, tenant_id e nivel são obrigatórios.'
    });
  }
  const niveisValidos: DelegationExceptionLevel[] = ['AUTONOMO', 'MEDIANTE_APROVACAO', 'BLOQUEADA'];
  if (!niveisValidos.includes(nivel)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: "nivel deve ser 'AUTONOMO', 'MEDIANTE_APROVACAO' ou 'BLOQUEADA'."
    });
  }

  const now = new Date().toISOString();
  let exception: DelegationException | undefined = dbStore.delegationExceptions.find(
    (e) => e.insurer_id === insurer_id && e.broker_id === broker_id && e.tenant_id === tenant_id
  );
  if (exception) {
    exception.nivel = nivel;
    exception.updated_at = now;
  } else {
    exception = { id: uuidv4(), insurer_id, broker_id, tenant_id, nivel, created_at: now, updated_at: now };
    dbStore.delegationExceptions.push(exception);
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', exception });
});

router.delete('/delegation-exceptions/:id', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const exception = dbStore.delegationExceptions.find((e) => e.id === id);
  if (!exception) {
    return res.status(404).json({ status: 'erro', mensagem: 'Exceção não encontrada.' });
  }
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && exception.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta exceção não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  // Remover a exceção faz o segurado voltar a seguir a matriz geral (DelegationPermission).
  dbStore.delegationExceptions = dbStore.delegationExceptions.filter((e) => e.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Exceção removida — segurado volta a seguir a matriz geral.' });
});


export default router;
