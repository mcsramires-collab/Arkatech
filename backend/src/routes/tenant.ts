import { Router, Response } from 'express';
import { dbStore } from '../services/dbStore';
import { AverbacaoService } from '../services/averbacao';
import { ResponseEngine } from '../services/responseEngine';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';

const router = Router();

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

const checkActivated = (tenantId: string) => {
  const tenant = dbStore.tenants.find((t) => t.id === tenantId);
  if (!tenant) return { ok: false, code: 404, body: { status: 'erro', mensagem: 'Cliente não encontrado.' } };
  if (!tenant.conta_ativada) {
    return {
      ok: false,
      code: 403,
      body: {
        status: 'erro',
        codigo: 'ERR-4009',
        mensagem: 'Conta ainda não ativada. Aceite o Termo de Uso para acessar o portal.'
      }
    };
  }
  return { ok: true, tenant };
};

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

// --- Histórico de Averbações do Próprio CNPJ (linguagem simples) ---
router.get('/averbacoes', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const gate = checkActivated(tenantId);
  if (!gate.ok) return res.status(gate.code ?? 400).json(gate.body);

  const items = dbStore.averbacoes
    .filter((a) => a.tenant_id === tenantId)
    .map((a) => {
      const template = dbStore.responseTemplates.find((t) => t.codigo === a.codigo_resposta);
      return {
        ...a,
        explicacao_nao_tecnica: template?.explicacao_nao_tecnica
      };
    });

  return res.json({ status: 'sucesso', averbacoes: items });
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

export default router;
