import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { ResponseEngine } from '../services/responseEngine';
import { getJwtSecret } from '../utils/jwtSecret';
import { backofficeAuthMiddleware, BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';

const router = Router();

/**
 * POST /api/v1/auth/token
 * Autenticação via Client Credentials (client_id + client_secret).
 */
router.post('/token', (req: Request, res: Response) => {
  const { client_id, client_secret } = req.body;

  if (!client_id || !client_secret) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'ERR-4001',
      mensagem: 'client_id e client_secret são obrigatórios.'
    });
  }

  const tenant = dbStore.tenants.find(
    (t) => t.client_id === client_id && t.client_secret_hash === client_secret
  );

  if (!tenant) {
    const errFormat = ResponseEngine.formatResponse('ERR-4001');
    return res.status(401).json({
      status: 'erro',
      codigo: errFormat.codigo,
      mensagem: 'Credenciais de client_id ou client_secret inválidas.'
    });
  }

  const durationHours = tenant.token_duration_hours || 8;
  const expiresInSeconds = durationHours * 3600;

  const payload = {
    tenant_id: tenant.id,
    cnpj: tenant.cnpj,
    razao_social: tenant.razao_social,
    ambiente: tenant.ambiente,
    role: tenant.role
  };

  let jwtSecret: string;
  try {
    jwtSecret = getJwtSecret();
  } catch (err) {
    // Falha de configuração do servidor (JWT_SECRET ausente) — não é erro do cliente.
    return res.status(500).json({
      status: 'erro',
      codigo: 'ERR-5000',
      mensagem: 'Erro interno ao emitir o token. Contate o suporte da Arckatech.'
    });
  }

  const token = jwt.sign(payload, jwtSecret, { expiresIn: expiresInSeconds });

  return res.json({
    status: 'sucesso',
    token_type: 'Bearer',
    access_token: token,
    expires_in: expiresInSeconds,
    ambiente: tenant.ambiente,
    doc_autenticacao: {
      instrucao: 'Inclua este token no cabeçalho HTTP de todas as requisições de averbação.',
      header_exemplo: `Authorization: Bearer ${token}`
    }
  });
});

/**
 * POST /api/v1/auth/portal-login
 * Login por PESSOA (email + senha) para o Portal do Segurado — diferente de POST /token,
 * que autentica a EMPRESA inteira via client_id/client_secret (usado por integrações
 * máquina-a-máquina). Aqui quem loga é um TenantUser específico.
 *
 * Um mesmo e-mail pode existir em mais de um TenantUser (uma linha por empresa em que a
 * pessoa é usuária) — é assim que representamos "meu usuário tem acesso a mais de uma
 * transportadora/embarcadora". Por isso o login retorna uma LISTA de empresas, cada uma já
 * com seu próprio JWT pronto (o Portal troca de "empresa ativa" só trocando qual token usa,
 * sem precisar logar de novo). Isso é intencionalmente diferente do painel da seguradora/
 * corretora (Portal da Seguradora, x-internal-api-key) — lá sim uma única conta enxerga
 * várias empresas *de clientes diferentes*; aqui é a mesma pessoa vinculada a mais de uma
 * empresa dela mesma (ex: mesmo grupo econômico com CNPJs distintos).
 */
router.post('/portal-login', async (req: Request, res: Response) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'ERR-4001',
      mensagem: 'email e senha são obrigatórios.'
    });
  }

  const emailNormalizado = String(email).trim().toLowerCase();
  const candidatos = dbStore.tenantUsers.filter(
    (u) => u.email.trim().toLowerCase() === emailNormalizado && u.status === 'ATIVO'
  );

  const credenciaisInvalidas = () =>
    res.status(401).json({
      status: 'erro',
      codigo: 'ERR-4001',
      mensagem: 'E-mail ou senha inválidos.'
    });

  if (candidatos.length === 0) {
    return credenciaisInvalidas();
  }

  // A senha é validada contra QUALQUER uma das linhas com esse e-mail — na prática, o mesmo
  // convite costuma usar a mesma senha em todas as empresas da pessoa, mas o sistema não
  // impõe isso estruturalmente (cada TenantUser guarda seu próprio password_hash).
  let usuarioAutenticado: (typeof candidatos)[number] | undefined;
  for (const candidato of candidatos) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(senha, candidato.password_hash)) {
      usuarioAutenticado = candidato;
      break;
    }
  }

  if (!usuarioAutenticado) {
    return credenciaisInvalidas();
  }

  let jwtSecret: string;
  try {
    jwtSecret = getJwtSecret();
  } catch (err) {
    return res.status(500).json({
      status: 'erro',
      codigo: 'ERR-5000',
      mensagem: 'Erro interno ao emitir o token. Contate o suporte da Arckatech.'
    });
  }

  const empresas = dbStore.tenantUsers
    .filter((u) => u.email.trim().toLowerCase() === emailNormalizado && u.status === 'ATIVO')
    .map((u) => {
      const tenant = dbStore.tenants.find((t) => t.id === u.tenant_id);
      if (!tenant) return null;

      const durationHours = tenant.token_duration_hours || 8;
      const expiresInSeconds = durationHours * 3600;
      const payload = {
        tenant_id: tenant.id,
        cnpj: tenant.cnpj,
        razao_social: tenant.razao_social,
        ambiente: tenant.ambiente,
        role: tenant.role,
        tenant_user_id: u.id,
        tenant_user_nome: u.nome,
        is_admin_da_conta: Boolean(u.is_admin_da_conta)
      };
      const token = jwt.sign(payload, jwtSecret, { expiresIn: expiresInSeconds });

      return {
        tenant_id: tenant.id,
        razao_social: tenant.razao_social,
        cnpj: tenant.cnpj,
        status: tenant.status,
        conta_ativada: Boolean(tenant.conta_ativada),
        papel: u.is_admin_da_conta ? 'Admin' : 'Operacional',
        token_type: 'Bearer' as const,
        access_token: token,
        expires_in: expiresInSeconds
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (empresas.length === 0) {
    return res.status(404).json({
      status: 'erro',
      mensagem: 'Nenhuma empresa ativa vinculada a este usuário.'
    });
  }

  return res.json({
    status: 'sucesso',
    usuario: { nome: usuarioAutenticado.nome, email: usuarioAutenticado.email },
    empresas
  });
});

/**
 * POST /api/v1/auth/backoffice-login
 * Login por PESSOA (email + senha) para os painéis internos — Seguradora, Corretora e a própria
 * Arckatech (ADM/Agente). É o equivalente de /portal-login (Portal do Segurado), mas para os
 * três outros públicos, cobrindo os tipos que já existem em types/index.ts (InternalUser,
 * TenantUser com tenant.role SEGURADORA/CORRETORA) e que hoje não têm nenhuma rota de login.
 *
 * ⚠️ Este endpoint funciona de ponta a ponta (emite um JWT real, validável por
 * backofficeAuthMiddleware), mas ainda NÃO está exigido em nenhuma rota de /admin ou /broker —
 * ver o comentário em authMiddleware.ts sobre por que isso precisa esperar as telas de login
 * reais nos dois portais (Backlog: "Login real + RBAC").
 *
 * Busca primeiro em InternalUser (ADM/Agente Arckatech); se não achar, busca em TenantUser cujo
 * Tenant tenha role SEGURADORA ou CORRETORA (deliberadamente exclui TRANSPORTADOR — esse público
 * já loga por /portal-login). Para SEGURADORA/CORRETORA, resolve o Insurer/Broker vinculado ao
 * Tenant (via Insurer.tenant_id / Broker.tenant_id) para carregar insurer_id/broker_id no token —
 * é esse id, não o tenant_id, que RbacProfile.owner_id referencia (ver types/index.ts).
 */
router.post('/backoffice-login', async (req: Request, res: Response) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'ERR-4001',
      mensagem: 'email e senha são obrigatórios.'
    });
  }

  const emailNormalizado = String(email).trim().toLowerCase();

  const credenciaisInvalidas = () =>
    res.status(401).json({
      status: 'erro',
      codigo: 'ERR-4001',
      mensagem: 'E-mail ou senha inválidos.'
    });

  let jwtSecret: string;
  try {
    jwtSecret = getJwtSecret();
  } catch (err) {
    return res.status(500).json({
      status: 'erro',
      codigo: 'ERR-5000',
      mensagem: 'Erro interno ao emitir o token. Contate o suporte da Arckatech.'
    });
  }

  // 1) InternalUser (ADM/Agente Arckatech)
  const internalCandidato = dbStore.internalUsers.find(
    (u) => u.email.trim().toLowerCase() === emailNormalizado && u.status === 'ATIVO'
  );
  if (internalCandidato) {
    if (!(await bcrypt.compare(senha, internalCandidato.password_hash))) {
      return credenciaisInvalidas();
    }

    const payload = {
      actor_type: 'INTERNAL_USER' as const,
      user_id: internalCandidato.id,
      nome: internalCandidato.nome,
      email: internalCandidato.email,
      role: internalCandidato.role,
      rbac_profile_id: internalCandidato.rbac_profile_id,
      // Fase 5 (item 3) — identificador único deste token específico, usado só para revogação
      // (ver POST /auth/backoffice-logout abaixo e RevokedToken em types/index.ts).
      jti: uuidv4()
    };
    const expiresInSeconds = 8 * 3600;
    const token = jwt.sign(payload, jwtSecret, { expiresIn: expiresInSeconds });

    return res.json({
      status: 'sucesso',
      usuario: { nome: internalCandidato.nome, email: internalCandidato.email, tipo: 'ARCKATECH', papel: internalCandidato.role },
      token_type: 'Bearer',
      access_token: token,
      expires_in: expiresInSeconds
    });
  }

  // 2) TenantUser de Seguradora/Corretora (nunca TRANSPORTADOR — esse é /portal-login)
  const tenantCandidatos = dbStore.tenantUsers.filter(
    (u) => u.email.trim().toLowerCase() === emailNormalizado && u.status === 'ATIVO'
  );

  for (const candidato of tenantCandidatos) {
    const tenant = dbStore.tenants.find((t) => t.id === candidato.tenant_id);
    if (!tenant || (tenant.role !== 'SEGURADORA' && tenant.role !== 'CORRETORA')) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await bcrypt.compare(senha, candidato.password_hash))) continue;

    const isSeguradora = tenant.role === 'SEGURADORA';
    const insurer = isSeguradora ? dbStore.insurers.find((i) => i.tenant_id === tenant.id) : undefined;
    const broker = !isSeguradora ? dbStore.brokers.find((b) => b.tenant_id === tenant.id) : undefined;

    const payload = {
      actor_type: (isSeguradora ? 'SEGURADORA' : 'CORRETORA') as 'SEGURADORA' | 'CORRETORA',
      user_id: candidato.id,
      nome: candidato.nome,
      email: candidato.email,
      role: tenant.role,
      rbac_profile_id: candidato.rbac_profile_id,
      tenant_id: tenant.id,
      insurer_id: insurer?.id,
      broker_id: broker?.id,
      // Fase 5 (item 3) — mesmo propósito do branch INTERNAL_USER acima.
      jti: uuidv4()
    };
    const durationHours = tenant.token_duration_hours || 8;
    const expiresInSeconds = durationHours * 3600;
    const token = jwt.sign(payload, jwtSecret, { expiresIn: expiresInSeconds });

    return res.json({
      status: 'sucesso',
      usuario: {
        nome: candidato.nome,
        email: candidato.email,
        tipo: tenant.role,
        razao_social: tenant.razao_social,
        insurer_id: insurer?.id,
        broker_id: broker?.id
      },
      token_type: 'Bearer',
      access_token: token,
      expires_in: expiresInSeconds
    });
  }

  return credenciaisInvalidas();
});

/**
 * POST /api/v1/auth/backoffice-logout
 * Fase 5 (item 3) do "Login real + RBAC" (Backlog, seção 4) — logout que de fato invalida o
 * token no servidor, não só localmente. Exige `backofficeAuthMiddleware` (o token apresentado
 * precisa ser válido, não vencido e ainda não revogado) e revoga só ELE MESMO — `jti` do próprio
 * Bearer usado nesta chamada, nunca um `jti` informado pelo corpo da requisição (evitaria alguém
 * derrubar a sessão de outra pessoa só adivinhando/roubando um `jti` alheio sem o token completo).
 *
 * `req.backoffice.exp` é o claim `exp` do JWT em epoch SEGUNDOS (padrão do próprio token) — como
 * `RevokedToken.expires_at` é epoch MILISSEGUNDOS (mesma unidade usada em todo o resto do
 * backend, ex.: `Tenant.token_duration_max_hours`/sessão do frontend), a conversão é `* 1000`.
 *
 * Continua sendo uma revogação pontual (só este token) — não é "sair de todos os dispositivos"
 * (cada login gera um `jti` novo; logar em dois lugares e deslogar de um não afeta o outro). Essa
 * ideia mais ampla está mapeada, não implementada, no desenho da opção "b" no Backlog.
 */
router.post('/backoffice-logout', backofficeAuthMiddleware, (req: BackofficeAuthenticatedRequest, res: Response) => {
  const ator = req.backoffice!; // garantido por backofficeAuthMiddleware
  if (ator.jti && ator.exp) {
    dbStore.revokeToken(ator.jti, ator.exp * 1000, ator.user_id, 'logout');
  }
  return res.json({ status: 'sucesso', mensagem: 'Sessão encerrada — o token usado não é mais válido.' });
});

export default router;
