import { Router, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { dbStore } from '../services/dbStore';
import { AverbacaoService } from '../services/averbacao';
import { ResponseEngine } from '../services/responseEngine';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { checkActivated } from '../services/accountActivation';
import { TenantUser, BusinessRuleRequest } from '../types';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * Rotas do Portal do Transportador/Embarcador.
 *
 * /policies, /averbacoes e /recovery-pendentes agora exigem o JWT emitido por
 * POST /api/v1/auth/token (authMiddleware) e usam o tenant_id do próprio token —
 * não mais um tenant_id livre por query string. Isso fecha a brecha em que qualquer
 * pessoa que soubesse (ou adivinhasse) o tenant_id de outra empresa conseguia ver
 * as apólices e averbações dela (o comentário anterior deste arquivo já registrava
 * isso como pendência de produção).
 *
 * /importar-lote e /users seguem o mesmo padrão: tenant_id sempre vem do JWT,
 * nunca de um campo livre no body/query — nenhuma empresa consegue importar
 * documentos ou gerenciar usuários em nome de outro tenant.
 *
 * /activation-status, /activation/:token/aceitar e /recovery/:token/corrigir
 * permanecem sem JWT de propósito: são fluxos de "link enviado por e-mail" — o
 * transportador ainda não teria como obter um token antes de aceitar o convite —,
 * no mesmo padrão já usado em /api/v1/averbar/recuperar/:token.
 *
 * /notification-preferences também permanece como está por enquanto: é escopado
 * por tenant_user_id (usuário individual dentro da empresa), e o JWT atual só
 * carrega identidade da EMPRESA (tenant), não do usuário — não existe ainda login
 * por usuário dentro do tenant. Proteger essa rota direito depende de login
 * individual (TenantUser) existir primeiro.
 */

// checkActivated agora vive em services/accountActivation.ts — reaproveitado também por
// routes/averbacao.ts (ver comentário lá).

// --- Status de Ativação da Conta (Termo de Uso) ---
router.get('/activation-status', (req, res) => {
  const tenantId = String(req.query.tenant_id || '');
  const tenant = dbStore.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });
  }

  const pendingToken = dbStore.activationTokens.find((a) => a.tenant_id === tenantId && !a.aceite);

  return res.json({
    status: 'sucesso',
    conta_ativada: Boolean(tenant.conta_ativada),
    token_pendente: pendingToken ? pendingToken.token : null,
    termo_versao: pendingToken?.termo_versao
  });
});

router.post('/activation/:token/aceitar', (req, res) => {
  const { token } = req.params;
  const activation = dbStore.activationTokens.find((a) => a.token === token);

  if (!activation) {
    return res.status(404).json({ status: 'erro', mensagem: 'Token de ativação inválido.' });
  }
  if (new Date(activation.expira_em) < new Date()) {
    return res.status(400).json({ status: 'erro', mensagem: 'Token de ativação expirado. Solicite um novo convite.' });
  }

  activation.aceite = true;
  activation.aceite_em = new Date().toISOString();

  const tenant = dbStore.tenants.find((t) => t.id === activation.tenant_id);
  if (tenant) tenant.conta_ativada = true;

  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Conta ativada com sucesso.', tenant });
});

/**
 * GET /tenant/activation/:token
 * Consulta pública (sem JWT) dos dados de um convite pelo TOKEN — usada pela tela de "definir
 * senha" do Portal do Segurado (link recebido por e-mail) para mostrar de qual empresa é o
 * convite antes da pessoa preencher qualquer coisa. Sem JWT de propósito, no mesmo padrão já
 * usado em /api/v1/averbar/recuperar/:token — quem recebe o e-mail ainda não tem token nenhum.
 */
router.get('/activation/:token', (req, res) => {
  const { token } = req.params;
  const activation = dbStore.activationTokens.find((a) => a.token === token);

  if (!activation) {
    return res.status(404).json({ status: 'erro', mensagem: 'Convite inválido.' });
  }

  const tenant = dbStore.tenants.find((t) => t.id === activation.tenant_id);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });
  }

  return res.json({
    status: 'sucesso',
    convite: {
      razao_social: tenant.razao_social,
      cnpj: tenant.cnpj,
      nome_convidado: activation.convite_nome,
      email_convidado: activation.convite_email,
      termo_versao: activation.termo_versao,
      ja_aceito: activation.aceite,
      expirado: new Date(activation.expira_em) < new Date()
    }
  });
});

/**
 * POST /tenant/activation/:token/definir-senha
 * Aceita o Termo de Uso e define a senha inicial NUM ÚNICO PASSO (Fase B do plano de convite por
 * e-mail — ver claude/Mapeamento_Portais_e_Personas.md, Ponto 2, no Project). Antes, aceitar o
 * Termo (/activation/:token/aceitar, acima) e criar um TenantUser com login (POST /tenant/users,
 * que exige JWT — ou seja, alguém já logado) eram dois passos completamente desconectados: não
 * existia nenhum jeito de uma pessoa que AINDA NÃO tem login sair de um convite por e-mail já
 * com uma conta utilizável. Esta rota cria o TenantUser inicial (admin da conta) no mesmo
 * momento em que o Termo é aceito, a partir dos dados gravados no próprio convite.
 */
router.post('/activation/:token/definir-senha', async (req, res) => {
  const { token } = req.params;
  const { senha } = req.body;

  if (!senha || String(senha).length < 8) {
    return res.status(400).json({ status: 'erro', mensagem: 'Senha é obrigatória e precisa ter ao menos 8 caracteres.' });
  }

  const activation = dbStore.activationTokens.find((a) => a.token === token);
  if (!activation) {
    return res.status(404).json({ status: 'erro', mensagem: 'Convite inválido.' });
  }
  if (activation.aceite) {
    return res.status(400).json({ status: 'erro', mensagem: 'Este convite já foi utilizado. Faça login normalmente.' });
  }
  if (new Date(activation.expira_em) < new Date()) {
    return res.status(400).json({ status: 'erro', mensagem: 'Convite expirado. Peça para sua seguradora ou corretora reenviar o convite.' });
  }

  const tenant = dbStore.tenants.find((t) => t.id === activation.tenant_id);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });
  }

  const email = (activation.convite_email || tenant.contato_email || '').trim().toLowerCase();
  const nome = activation.convite_nome || tenant.contato_nome || tenant.razao_social;

  if (!email) {
    return res.status(400).json({ status: 'erro', mensagem: 'Este convite não tem e-mail associado. Contate o suporte.' });
  }

  // Evita duplicar caso, por algum motivo, já exista um TenantUser com esse e-mail neste tenant
  // (ex: alguém criou manualmente via POST /tenant/users antes da pessoa aceitar o convite).
  let user = dbStore.tenantUsers.find(
    (u) => u.tenant_id === tenant.id && u.email.trim().toLowerCase() === email
  );

  const passwordHash = await bcrypt.hash(senha, 10);

  if (user) {
    user.password_hash = passwordHash;
    user.status = 'ATIVO';
  } else {
    user = {
      id: uuidv4(),
      tenant_id: tenant.id,
      nome,
      email,
      password_hash: passwordHash,
      is_admin_da_conta: true,
      status: 'ATIVO',
      created_at: new Date().toISOString()
    };
    dbStore.tenantUsers.push(user);
  }

  activation.aceite = true;
  activation.aceite_em = new Date().toISOString();
  tenant.conta_ativada = true;

  dbStore.persist();

  const { password_hash, ...userSemSenha } = user;
  return res.json({
    status: 'sucesso',
    mensagem: 'Conta ativada e senha definida com sucesso. Você já pode fazer login.',
    user: userSemSenha,
    tenant: { id: tenant.id, razao_social: tenant.razao_social, cnpj: tenant.cnpj }
  });
});

// --- Apólices/Seguradoras/Corretoras Vinculadas ao Próprio CNPJ ---
router.get('/policies', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const policies = dbStore.policies
    .filter((p) => p.tenant_id === tenantId)
    .map((p) => {
      const insurer = dbStore.insurers.find((i) => i.id === p.insurer_id);
      const broker = dbStore.brokers.find((b) => b.id === p.broker_id);
      return {
        ...p,
        seguradora: insurer?.nome_fantasia || insurer?.nome,
        corretora: broker?.nome_fantasia || broker?.nome
      };
    });

  return res.json({ status: 'sucesso', policies });
});

// --- Importação de Documentos Fiscais em Lote (equivalente ao /admin/importar-lote,
// porém sem tenant_id livre no body: o tenant vem sempre do próprio JWT, então uma
// empresa jamais consegue importar documentos "em nome" de outro tenant) ---
router.post(
  '/importar-lote',
  authMiddleware,
  upload.array('arquivos', 200),
  (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenant!.tenant_id;
    const gate = checkActivated(tenantId);
    if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

    const { ramo } = req.body;
    const files = req.files as Express.Multer.File[] | undefined;

    if (!ramo) {
      return res.status(400).json({ status: 'erro', mensagem: 'ramo é obrigatório.' });
    }
    if (!files || files.length === 0) {
      return res.status(400).json({ status: 'erro', mensagem: 'Nenhum arquivo XML foi enviado.' });
    }

    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    const resultados = files.map((file) => {
      const xmlContent = file.buffer.toString('utf-8');
      const resultado = AverbacaoService.process({ tenant_id: tenantId, ramo, xml_content: xmlContent }, appBaseUrl);
      return {
        arquivo: file.originalname,
        status: resultado.status,
        codigo: resultado.codigo,
        mensagem: resultado.mensagem,
        numero_averbacao: resultado.numero_averbacao,
        variaveis_faltantes: resultado.variaveis_faltantes
      };
    });

    const totalSucesso = resultados.filter((r) => r.status === 'sucesso' || r.status === 'aviso').length;
    const totalErro = resultados.filter((r) => r.status === 'erro').length;

    return res.json({
      status: 'sucesso',
      total: resultados.length,
      total_sucesso: totalSucesso,
      total_erro: totalErro,
      resultados
    });
  }
);

// --- Histórico de Averbações do Próprio CNPJ (linguagem simples), com paginação e filtros ---
router.get('/averbacoes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const { status, tipo_documento, numero_averbacao, chave_documento, data_de, data_ate } = req.query;

  let filtered = dbStore.averbacoes.filter((a) => a.tenant_id === tenantId);

  if (status) {
    filtered = filtered.filter((a) => a.status === String(status).toUpperCase());
  }
  if (tipo_documento) {
    filtered = filtered.filter((a) => a.tipo_documento === String(tipo_documento).toUpperCase());
  }
  if (numero_averbacao) {
    const needle = String(numero_averbacao).toLowerCase();
    filtered = filtered.filter((a) => (a.numero_averbacao ?? '').toLowerCase().includes(needle));
  }
  if (chave_documento) {
    filtered = filtered.filter((a) => a.chave_documento === String(chave_documento));
  }
  if (data_de) {
    const from = new Date(String(data_de));
    if (!isNaN(from.getTime())) filtered = filtered.filter((a) => new Date(a.created_at) >= from);
  }
  if (data_ate) {
    const to = new Date(String(data_ate));
    if (!isNaN(to.getTime())) filtered = filtered.filter((a) => new Date(a.created_at) <= to);
  }

  const totalItems = filtered.length;

  const pageRaw = Number(req.query.page);
  const pageSizeRaw = Number(req.query.page_size);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 200) : 20;

  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  const startIndex = (page - 1) * pageSize;

  const items = filtered.slice(startIndex, startIndex + pageSize).map((a) => {
    const template = dbStore.responseTemplates.find((t) => t.codigo === a.codigo_resposta);
    return {
      ...a,
      explicacao_nao_tecnica: template?.explicacao_nao_tecnica
    };
  });

  return res.json({
    status: 'sucesso',
    averbacoes: items,
    paginacao: {
      pagina: page,
      tamanho_pagina: pageSize,
      total_itens: totalItems,
      total_paginas: totalPages
    }
  });
});

// --- Pendências de Correção (variáveis faltantes) — sem precisar do link externo ---
router.get('/recovery-pendentes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const pendentes = dbStore.recoverySessions.filter(
    (r) => r.tenant_id === tenantId && !r.utilizada && new Date(r.expira_em) > new Date()
  );

  return res.json({ status: 'sucesso', pendencias: pendentes });
});

// --- Usuários do Próprio Tenant (equivalente ao /admin/tenant-users, porém sempre
// escopado ao tenant_id do JWT — nunca a um tenant_id arbitrário vindo de query/body,
// para uma empresa não conseguir listar/criar/editar/remover usuários de outra) ---
router.get('/users', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const items = dbStore.tenantUsers
    .filter((u) => u.tenant_id === tenantId)
    .map(({ password_hash, ...userSemSenha }) => userSemSenha);
  return res.json({ status: 'sucesso', users: items });
});

/**
 * Gera uma senha temporária aleatória para um TenantUser recém-criado. Como ainda não existe
 * envio de e-mail integrado neste sistema (nem aqui, nem em /admin/tenant-users), a senha em
 * texto plano é devolvida UMA ÚNICA VEZ na resposta deste POST — quem criar o usuário precisa
 * repassá-la para a pessoa por um canal separado. Não há ainda fluxo de "esqueci minha senha".
 */
function gerarSenhaTemporaria(): string {
  return crypto.randomBytes(9).toString('base64url');
}

router.post('/users', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { nome, email, rbac_profile_id, is_admin_da_conta } = req.body;

  if (!nome || !email) {
    return res.status(400).json({ status: 'erro', mensagem: 'nome e email são obrigatórios.' });
  }

  const senhaTemporaria = gerarSenhaTemporaria();
  const passwordHash = await bcrypt.hash(senhaTemporaria, 10);

  const newUser: TenantUser = {
    id: uuidv4(),
    tenant_id: tenantId,
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

router.put('/users/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { id } = req.params;
  const user = dbStore.tenantUsers.find((u) => u.id === id && u.tenant_id === tenantId);
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

router.delete('/users/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { id } = req.params;
  const exists = dbStore.tenantUsers.some((u) => u.id === id && u.tenant_id === tenantId);
  if (!exists) {
    return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado.' });
  }

  dbStore.tenantUsers = dbStore.tenantUsers.filter((u) => !(u.id === id && u.tenant_id === tenantId));
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Usuário removido com sucesso.' });
});

// --- Corrigir Direto no Portal (mesmo mecanismo do link de recuperação, sem sair da tela) ---
router.post('/recovery/:token/corrigir', (req, res) => {
  const { token } = req.params;
  const { supplemented_vars } = req.body;

  const session = dbStore.recoverySessions.find((r) => r.token === token && !r.utilizada);
  if (!session) {
    return res.status(400).json(ResponseEngine.formatResponse('ERR-4006'));
  }

  const policy = dbStore.policies.find((p) => p.id === session.policy_id)!;
  const appBaseUrl = `${req.protocol}://${req.get('host')}`;

  const result = AverbacaoService.process(
    {
      tenant_id: session.tenant_id,
      ramo: policy.ramo,
      xml_content: session.raw_xml_content,
      recovery_token: token,
      supplemented_vars
    },
    appBaseUrl
  );

  const statusCode = result.status === 'erro' ? 400 : 200;
  return res.status(statusCode).json(result);
});

// --- Preferências de Notificação (MVP: apenas e-mail + portal; WhatsApp/SMS fora por ora) ---
router.get('/notification-preferences', (req, res) => {
  const tenantUserId = String(req.query.tenant_user_id || '');
  const prefs = dbStore.notificationPreferences.filter((p) => p.tenant_user_id === tenantUserId);
  return res.json({ status: 'sucesso', preferences: prefs });
});

router.put('/notification-preferences', (req, res) => {
  const { tenant_user_id, canal, ativo } = req.body;

  if (!tenant_user_id || !canal) {
    return res.status(400).json({ status: 'erro', mensagem: 'tenant_user_id e canal são obrigatórios.' });
  }

  if (canal === 'SMS') {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Canal SMS ainda não disponível nesta versão — apenas E-mail e notificação no Portal.'
    });
  }

  let pref = dbStore.notificationPreferences.find((p) => p.tenant_user_id === tenant_user_id && p.canal === canal);
  if (pref) {
    pref.ativo = Boolean(ativo);
  } else {
    pref = { id: `np_${Date.now()}`, tenant_user_id, canal, ativo: Boolean(ativo) };
    dbStore.notificationPreferences.push(pref);
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', preference: pref });
});

// --- Solicitações de Regras de Negócio (MVP) — o transportador/embarcador solicita uma condição
// nova ou uma alteração de regra existente na apólice; quem aprova/rejeita é a seguradora
// (PUT /admin/regras-solicitacoes/:id). Sem fluxo de aprovação automática nesta versão.
router.get('/regras-solicitacoes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const items = dbStore.businessRuleRequests
    .filter((r) => r.tenant_id === tenantId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return res.json({ status: 'sucesso', solicitacoes: items });
});

router.post('/regras-solicitacoes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { tipo, descricao } = req.body;

  if (!tipo) {
    return res.status(400).json({ status: 'erro', mensagem: 'tipo é obrigatório.' });
  }

  const solicitanteNome = req.tenant!.tenant_user_nome || req.tenant!.razao_social;

  const newRequest: BusinessRuleRequest = {
    id: uuidv4(),
    tenant_id: tenantId,
    tipo,
    descricao,
    status: 'PENDENTE',
    solicitante_nome: solicitanteNome,
    created_at: new Date().toISOString()
  };
  dbStore.businessRuleRequests.unshift(newRequest);
  dbStore.persist();

  return res.json({ status: 'sucesso', solicitacao: newRequest });
});

// --- Estatísticas do Dashboard (Início do Portal) — agregados simples sobre os dados reais do
// próprio tenant; nada aqui é mockado, mas propositalmente não inclui nada que exija consultas
// caras (ex: sem paginação/filtro — o volume de dados de demonstração é pequeno).
router.get('/dashboard-stats', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;

  const averbacoesTenant = dbStore.averbacoes.filter((a) => a.tenant_id === tenantId);
  const totalAverbacoes = averbacoesTenant.filter((a) => a.status === 'SUCESSO').length;
  const totalRecusadas = averbacoesTenant.filter((a) => a.status === 'ERRO').length;
  const totalPendentes = dbStore.recoverySessions.filter(
    (r) => r.tenant_id === tenantId && !r.utilizada && new Date(r.expira_em) > new Date()
  ).length;

  const valorTotalAverbado = averbacoesTenant
    .filter((a) => a.status === 'SUCESSO')
    .reduce((sum, a) => sum + (a.valor_considerado_averbacao || 0), 0);

  const solicitacoesRegrasPendentes = dbStore.businessRuleRequests.filter(
    (r) => r.tenant_id === tenantId && r.status === 'PENDENTE'
  ).length;

  const ultimasAverbacoes = averbacoesTenant.slice(0, 5).map((a) => ({
    id: a.id,
    numero_averbacao: a.numero_averbacao,
    status: a.status,
    tipo_documento: a.tipo_documento,
    chave_documento: a.chave_documento,
    valor_considerado_averbacao: a.valor_considerado_averbacao,
    created_at: a.created_at
  }));

  return res.json({
    status: 'sucesso',
    stats: {
      total_averbacoes: totalAverbacoes,
      total_recusadas: totalRecusadas,
      total_pendentes_recuperacao: totalPendentes,
      valor_total_averbado: valorTotalAverbado,
      solicitacoes_regras_pendentes: solicitacoesRegrasPendentes,
      ultimas_averbacoes: ultimasAverbacoes
    }
  });
});

export default router;
