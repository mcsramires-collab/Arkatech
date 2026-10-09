import { Router, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { dbStore } from '../services/dbStore';
import { AverbacaoService } from '../services/averbacao';
import { DocumentIngestionService } from '../services/ingestion/documentIngestion';
import { MultiFormatFiscalParser } from '../services/ingestion/multiFormatFiscalParser';
import { ResponseEngine } from '../services/responseEngine';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { requireAccountAdmin } from '../middleware/accountAdminMiddleware';
import { checkActivated } from '../services/accountActivation';
import { CancelamentoService } from '../services/cancelamento';
import { SupportService } from '../services/supportService';
import { TenantUser, BusinessRuleRequest, Policy, SupportChannel } from '../types';
import fiscalDocumentsRouter from './fiscalDocuments';
import connectorsRouter from './connectors';
import fiscalSyncRouter from './fiscalSync';
import fiscalEventsRouter from './fiscalEvents';
import { generateClientSecret, hashClientSecret } from '../utils/clientCredentials';
import notificationsRouter from './notifications';
import { tenantDashboardStats, validDashboardMonth } from '../services/tenantDashboardService';

const router = Router();
router.use('/fiscal-documents', fiscalDocumentsRouter);
router.use('/connectors', connectorsRouter);
router.use('/fiscal-sync', fiscalSyncRouter);
router.use('/fiscal-events', fiscalEventsRouter);
router.use('/notifications', notificationsRouter);
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
// Achado da auditoria de 27/08 (widgets da Home): o widget "Vigências e Parcerias" do Portal do
// Segurado precisa não só de seguradora/corretora líder (já devolvidos aqui), mas também de
// cocorretora e assessoria — que, no modelo de dados, são o MESMO cadastro de Broker referenciado
// por Policy.co_broker_id/assessoria_id (ver comentário em routes/admin.ts, "P. Corretoras /
// Assessorias"). Adicionados aqui pelo mesmo padrão de lookup já usado para seguradora/corretora.
router.get('/policies', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const policies = dbStore.policies
    .filter((p) => p.tenant_id === tenantId)
    .map((p) => {
      const insurer = dbStore.insurers.find((i) => i.id === p.insurer_id);
      const broker = dbStore.brokers.find((b) => b.id === p.broker_id);
      const coBroker = p.co_broker_id
        ? dbStore.brokers.find((b) => b.id === p.co_broker_id)
        : undefined;
      const assessoria = p.assessoria_id
        ? dbStore.brokers.find((b) => b.id === p.assessoria_id)
        : undefined;
      return {
        ...p,
        seguradora: insurer?.nome_fantasia || insurer?.nome,
        corretora: broker?.nome_fantasia || broker?.nome,
        cocorretora: coBroker ? (coBroker.nome_fantasia || coBroker.nome) : undefined,
        assessoria: assessoria ? (assessoria.nome_fantasia || assessoria.nome) : undefined
      };
    });

  return res.json({ status: 'sucesso', policies });
});

/**
 * POST /tenant/integration-credentials/rotate
 * Gera um novo segredo M2M para TMS/API. Só o administrador humano da conta pode rotacionar.
 * O segredo em texto puro é devolvido UMA única vez e nunca é persistido.
 */
router.post(
  '/integration-credentials/rotate',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenant!.tenant_id;
    if (!req.tenant!.tenant_user_id || !req.tenant!.is_admin_da_conta) {
      return res.status(403).json({
        status: 'erro',
        mensagem: 'Somente o administrador da conta pode rotacionar credenciais de integração.'
      });
    }

    const gate = checkActivated(tenantId);
    if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

    const tenant = dbStore.tenants.find((item) => item.id === tenantId);
    if (!tenant) {
      return res.status(404).json({ status: 'erro', mensagem: 'Empresa não encontrada.' });
    }

    const clientSecret = generateClientSecret();
    tenant.client_secret_hash = await hashClientSecret(clientSecret);
    dbStore.persist();

    return res.json({
      status: 'sucesso',
      client_id: tenant.client_id,
      client_secret: clientSecret,
      aviso: 'Copie o client_secret agora. Ele não poderá ser consultado novamente.'
    });
  }
);

// --- Importação de Documentos Fiscais em Lote (equivalente ao /admin/importar-lote,
// porém sem tenant_id livre no body: o tenant vem sempre do próprio JWT, então uma
// empresa jamais consegue importar documentos "em nome" de outro tenant) ---
//
// Achado da auditoria de 29/08 (reportado pelo usuário): a tela pedia pra escolher um único
// "ramo" (dropdown com opções fixas, sem nem listar RCDC corretamente) antes de enviar os XMLs —
// se o segurado não soubesse de cabeça qual ramo cada documento pertencia, ou tivesse mais de uma
// apólice ativa candidata, a importação simplesmente falhava com uma mensagem confusa. Agora a
// pessoa escolhe diretamente quais apólices ATIVAS (já buscadas via GET /tenant/policies) usar —
// pode marcar mais de uma — e cada arquivo XML é tentado contra CADA apólice selecionada; um
// mesmo documento pode ser aceito em uma apólice e recusado em outra, e o resultado devolve essa
// granularidade por combinação (arquivo × apólice) em vez de só por arquivo.
router.post(
  '/importar-lote',
  authMiddleware,
  upload.array('arquivos', 200),
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenant!.tenant_id;
    const gate = checkActivated(tenantId);
    if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Nenhum arquivo foi enviado. Formatos aceitos: XML, CSV, XLSX, PDF e TXT.'
      });
    }

    const policyIdsRaw = req.body.policy_ids;
    const policyIds: string[] = Array.isArray(policyIdsRaw)
      ? policyIdsRaw.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : typeof policyIdsRaw === 'string' && policyIdsRaw.length > 0
        ? [policyIdsRaw]
        : [];

    if (policyIds.length === 0) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Selecione ao menos uma apólice (policy_ids) para averbar os documentos.'
      });
    }

    const policiesAlvo: Policy[] = policyIds
      .map((id) => dbStore.policies.find((p) => p.id === id && p.tenant_id === tenantId))
      .filter((p): p is Policy => Boolean(p));

    if (policiesAlvo.length === 0) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Nenhuma das apólices informadas foi encontrada para esta empresa.'
      });
    }

    const parsedFiles: Array<{
      filename: string;
      xml_content: string;
    }> = [];
    const arquivosRejeitados: Array<{
      arquivo: string;
      codigo: string;
      mensagem: string;
    }> = [];
    const formatos: Record<string, number> = {};

    // Processamento sequencial proposital: PDF e XLSX podem ser pesados; não queremos abrir
    // dezenas deles simultaneamente e provocar pico de memória numa única requisição.
    for (const file of files) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const documentos = await MultiFormatFiscalParser.parse(file);
        for (const documento of documentos) {
          parsedFiles.push({
            filename: documento.filename,
            xml_content: documento.content
          });
          formatos[documento.format] = (formatos[documento.format] ?? 0) + 1;
        }
      } catch (error) {
        const raw = error instanceof Error ? error.message : 'Falha ao interpretar arquivo.';
        const [codigo, ...rest] = raw.split(':');
        arquivosRejeitados.push({
          arquivo: file.originalname,
          codigo: codigo || 'FILE_PARSE_ERROR',
          mensagem: rest.join(':').trim() || raw
        });
      }
    }

    if (parsedFiles.length === 0) {
      return res.status(422).json({
        status: 'erro',
        codigo: 'NO_VALID_FISCAL_DOCUMENTS',
        mensagem: 'Nenhum documento fiscal utilizável foi extraído dos arquivos enviados.',
        formatos_aceitos: MultiFormatFiscalParser.supportedExtensions(),
        arquivos_rejeitados: arquivosRejeitados
      });
    }

    const appBaseUrl = `${req.protocol}://${req.get('host')}`;
    const resultados = DocumentIngestionService.processXmlBatch({
      tenant_id: tenantId,
      source: 'PORTAL',
      app_base_url: appBaseUrl,
      files: parsedFiles,
      policies: policiesAlvo.map((policy) => ({
        id: policy.id,
        numero_apolice: policy.numero_apolice,
        ramo: policy.ramo
      }))
    });

    const totalSucesso = resultados.filter((r) => r.aceito_em_alguma_apolice).length;
    const totalErro = resultados.length - totalSucesso;

    return res.json({
      status: arquivosRejeitados.length > 0 ? 'aviso' : 'sucesso',
      arquivos_recebidos: files.length,
      documentos_extraidos: resultados.length,
      formatos,
      total_sucesso: totalSucesso,
      total_erro: totalErro,
      arquivos_rejeitados: arquivosRejeitados,
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
    const policy = dbStore.policies.find((p) => p.id === a.policy_id);
    return {
      ...a,
      ramo: policy?.ramo,
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

/**
 * POST /tenant/averbacoes/:id/reenviar — Fase 4 do pacote de 21/09 (documentos-
 * pendentes-campos-api.md pede exatamente isso: reenviar sem novo upload). Reprocessa o XML já
 * salvo de um documento PENDENTE_APROVACAO ou ERRO do próprio tenant, criando um NOVO registro
 * (o anterior fica intacto para histórico). Aceita `codigo_liberacao` opcional, útil quando a
 * pendência original foi por excedente de LMI sob a estratégia 'exigir-codigo'.
 */
router.post('/averbacoes/:id/reenviar', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const { id } = req.params;
  const averbacaoAnterior = dbStore.averbacoes.find((a) => a.id === id && a.tenant_id === tenantId);
  if (!averbacaoAnterior) {
    return res.status(404).json({ status: 'erro', mensagem: 'Documento não encontrado.' });
  }
  if (averbacaoAnterior.status !== 'PENDENTE_APROVACAO' && averbacaoAnterior.status !== 'ERRO') {
    return res.status(409).json({ status: 'erro', mensagem: 'Este documento não está pendente nem recusado — não há o que reenviar.' });
  }

  const { codigo_liberacao, supplemented_vars } = req.body;
  const appBaseUrl = `${req.protocol}://${req.get('host')}`;
  const resultado = AverbacaoService.reenviar(averbacaoAnterior, appBaseUrl, codigo_liberacao, supplemented_vars);
  const statusCode = resultado.status === 'erro' ? 400 : 200;
  return res.status(statusCode).json(resultado);
});

/**
 * POST /tenant/averbacoes/:id/cancelar — Motor de Cancelamento pós-averbação (pacote de 23/09,
 * compartilhado pelo usuário). Self-service: só funciona DENTRO do prazo que a seguradora
 * configurou para esta apólice (`regras:prazo-cancelamento-valor`/`-unidade`, aba Regras de
 * Negócio) — sem essa configuração, ou fora do prazo, o segurado é orientado a falar com a
 * seguradora (que cancela sem restrição via `POST /admin/averbacoes/:id/cancelar-averbado`).
 * Exige o evento de cancelamento REAL do Sefaz — ver CancelamentoService/XMLParserService.
 */
router.post('/averbacoes/:id/cancelar', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const { id } = req.params;
  const averbacaoAnterior = dbStore.averbacoes.find((a) => a.id === id && a.tenant_id === tenantId);
  if (!averbacaoAnterior) {
    return res.status(404).json({ status: 'erro', mensagem: 'Documento não encontrado.' });
  }

  const { xml_evento_cancelamento } = req.body;
  if (!xml_evento_cancelamento || typeof xml_evento_cancelamento !== 'string') {
    return res.status(400).json({ status: 'erro', mensagem: 'xml_evento_cancelamento é obrigatório.' });
  }

  const resultado = CancelamentoService.processar({
    averbacaoAnterior,
    xmlEvento: xml_evento_cancelamento,
    requisitante: 'SEGURADO'
  });

  const statusCode = resultado.status === 'erro' ? 400 : 200;
  return res.status(statusCode).json(resultado);
});

// --- Pendências de Correção (variáveis faltantes) — sem precisar do link externo ---
//
// Achado da auditoria de 27/08 (Documentos Pendentes, revisão do status "Negada"): o protótipo
// mockado antigo modelava esta tela com um status "Negada"/"Autorizada"/"Pendente" que nunca
// existiu de verdade no backend — o modelo real (RecoverySession) só distingue "utilizada"
// (corrigida com sucesso) de "não utilizada". Antes desta correção, uma pendência que passava do
// prazo de 24h simplesmente desaparecia desta lista sem nenhum aviso ao cliente — o documento
// nunca seria averbado, mas nada na tela dizia isso (e o backend, por um bug à parte corrigido
// junto — ver AverbacaoService.process — nem chegava a recusar a correção depois do prazo).
// Passa a expor um status real calculado (PENDENTE ainda dentro do prazo, EXPIRADA depois dele) e
// a incluir também as pendências expiradas recentemente (últimos 30 dias), para o cliente saber
// que precisa reenviar o documento em vez de simplesmente não ver mais nada sobre ele.
const RECOVERY_EXPIRADA_JANELA_MS = 30 * 24 * 60 * 60 * 1000;

router.get('/recovery-pendentes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const now = Date.now();

  const pendentes = dbStore.recoverySessions
    .filter((r) => r.tenant_id === tenantId && !r.utilizada)
    .filter((r) => now - new Date(r.expira_em).getTime() < RECOVERY_EXPIRADA_JANELA_MS)
    .map((r) => ({
      ...r,
      status: (new Date(r.expira_em).getTime() > now ? 'PENDENTE' : 'EXPIRADA') as 'PENDENTE' | 'EXPIRADA'
    }))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

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

router.post('/users', authMiddleware, requireAccountAdmin, async (req: AuthenticatedRequest, res: Response) => {
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

router.put('/users/:id', authMiddleware, requireAccountAdmin, (req: AuthenticatedRequest, res: Response) => {
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

router.delete('/users/:id', authMiddleware, requireAccountAdmin, (req: AuthenticatedRequest, res: Response) => {
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
      policy_id: policy.id,
      xml_content: session.raw_xml_content,
      recovery_token: token,
      supplemented_vars
    },
    appBaseUrl
  );

  const statusCode = result.status === 'erro' ? 400 : 200;
  return res.status(statusCode).json(result);
});

// --- Preferências pessoais de Notificação ---
// Diferente da versão antiga, o usuário NÃO informa tenant_user_id livremente. A identidade
// individual vem do JWT emitido por /auth/portal-login, impedindo leitura/alteração da
// preferência de outra pessoa da mesma empresa.
router.get('/notification-preferences', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantUserId = req.tenant!.tenant_user_id;
  if (!tenantUserId) {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'Preferências individuais exigem login de usuário pelo Portal.'
    });
  }

  const prefs = dbStore.notificationPreferences.filter((p) => p.tenant_user_id === tenantUserId);
  return res.json({ status: 'sucesso', preferences: prefs });
});

router.put('/notification-preferences', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantUserId = req.tenant!.tenant_user_id;
  const canal = String(req.body.canal || '').toUpperCase();
  const ativo = Boolean(req.body.ativo);

  if (!tenantUserId) {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'Preferências individuais exigem login de usuário pelo Portal.'
    });
  }
  if (canal !== 'EMAIL' && canal !== 'PORTAL') {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Nesta etapa, canal deve ser EMAIL ou PORTAL. WhatsApp será ligado na etapa de integração externa.'
    });
  }

  let pref = dbStore.notificationPreferences.find(
    (p) => p.tenant_user_id === tenantUserId && p.canal === canal
  );
  if (pref) {
    pref.ativo = ativo;
  } else {
    pref = { id: uuidv4(), tenant_user_id: tenantUserId, canal: canal as 'EMAIL' | 'PORTAL', ativo };
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

// --- Suporte conversacional ---
// O ticket e as mensagens usam o mesmo modelo independentemente do canal. Nesta etapa o Portal
// pode originar PORTAL/CHAT. WhatsApp e telefonia serão integrados depois, alimentando a mesma
// conversa sem criar um segundo sistema de chamados.
router.get('/suporte/chamados', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const chamados = dbStore.supportTickets
    .filter((ticket) => ticket.tenant_id === tenantId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((ticket) => ({
      ...ticket,
      mensagens: dbStore.supportMessages.filter((message) => message.ticket_id === ticket.id).length
    }));

  return res.json({ status: 'sucesso', chamados });
});

router.post('/suporte/chamados', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { assunto, categoria, descricao } = req.body;

  if (!assunto || !categoria || !descricao) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'assunto, categoria e descricao são obrigatórios.'
    });
  }

  const allowedPriorities = ['BAIXA', 'NORMAL', 'ALTA', 'CRITICA'] as const;
  const prioridade = String(req.body.prioridade || 'NORMAL').toUpperCase() as
    (typeof allowedPriorities)[number];
  if (!allowedPriorities.includes(prioridade)) {
    return res.status(400).json({ status: 'erro', mensagem: 'prioridade inválida.' });
  }

  const allowedChannels: SupportChannel[] = ['PORTAL', 'CHAT'];
  const canal = String(req.body.canal || 'PORTAL').toUpperCase() as SupportChannel;
  if (!allowedChannels.includes(canal)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Pelo Portal, canal deve ser PORTAL ou CHAT.'
    });
  }

  const solicitanteNome = req.tenant!.tenant_user_nome || req.tenant!.razao_social;
  const ticket = SupportService.createTicket({
    tenant_id: tenantId,
    tenant_user_id: req.tenant!.tenant_user_id,
    assunto: String(assunto),
    categoria: String(categoria),
    descricao: String(descricao),
    solicitante_nome: solicitanteNome,
    prioridade,
    canal_origem: canal
  });

  return res.json({
    status: 'sucesso',
    chamado: ticket,
    messages: SupportService.messages(ticket.id, tenantId)
  });
});

router.get('/suporte/chamados/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const ticket = SupportService.getTicket(tenantId, req.params.id);
  if (!ticket) {
    return res.status(404).json({ status: 'erro', mensagem: 'Chamado não encontrado.' });
  }

  return res.json({
    status: 'sucesso',
    chamado: ticket,
    messages: SupportService.messages(ticket.id, tenantId)
  });
});

router.post(
  '/suporte/chamados/:id/mensagens',
  authMiddleware,
  (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenant!.tenant_id;
    const ticket = SupportService.getTicket(tenantId, req.params.id);
    if (!ticket) {
      return res.status(404).json({ status: 'erro', mensagem: 'Chamado não encontrado.' });
    }

    const message = String(req.body.message || '').trim();
    if (!message) {
      return res.status(400).json({ status: 'erro', mensagem: 'message é obrigatório.' });
    }

    const entry = SupportService.addTenantMessage({
      ticket,
      tenant_user_id: req.tenant!.tenant_user_id,
      author_name: req.tenant!.tenant_user_nome || req.tenant!.razao_social,
      message,
      channel: 'CHAT'
    });

    return res.json({ status: 'sucesso', message: entry, chamado: ticket });
  }
);

router.put(
  '/suporte/chamados/:id/fechar',
  authMiddleware,
  (req: AuthenticatedRequest, res: Response) => {
    const tenantId = req.tenant!.tenant_id;
    const ticket = SupportService.getTicket(tenantId, req.params.id);
    if (!ticket) {
      return res.status(404).json({ status: 'erro', mensagem: 'Chamado não encontrado.' });
    }

    SupportService.updateTicket({ ticket, status: 'FECHADO' });
    return res.json({ status: 'sucesso', chamado: ticket });
  }
);

// Monthly metrics use persisted records in the business timezone. Pending queues remain current.
router.get('/dashboard-stats', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const month = req.query.mes;
  if (month !== undefined && !validDashboardMonth(month)) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'INVALID_DASHBOARD_MONTH',
      mensagem: 'Informe o mês no formato YYYY-MM.'
    });
  }

  return res.json({ status: 'sucesso', stats: tenantDashboardStats(tenantId, month) });
});

export default router;
