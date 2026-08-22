import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { dbStore } from '../services/dbStore';
import { ResponseEngine } from '../services/responseEngine';
import { getJwtSecret } from '../utils/jwtSecret';

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

export default router;
