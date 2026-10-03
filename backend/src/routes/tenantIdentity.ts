import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { dbStore } from '../services/dbStore';
import { PortalIdentityService } from '../services/portalIdentityService';
import { sendPortalUserInviteEmail } from '../services/portalIdentityEmailService';
import { TenantUser } from '../types';

const router = Router();

function requireAccountAdmin(req: AuthenticatedRequest, res: Response): boolean {
  if (!req.tenant?.tenant_user_id || !req.tenant.is_admin_da_conta) {
    res.status(403).json({
      status: 'erro',
      mensagem: 'Somente um administrador humano da conta pode convidar ou reenviar acesso de usuários.'
    });
    return false;
  }
  return true;
}

async function createUnavailablePasswordHash(): Promise<string> {
  // O valor nunca é enviado e nunca é conhecido por ninguém. O usuário só passa a ter uma
  // credencial utilizável quando consome o token de convite e define a própria senha.
  return bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 10);
}

router.post('/users/invite', authMiddleware, async (req: AuthenticatedRequest, res) => {
  if (!requireAccountAdmin(req, res)) return;
  const tenantId = req.tenant!.tenant_id;
  const nome = String(req.body?.nome || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const rbacProfileId = req.body?.rbac_profile_id ? String(req.body.rbac_profile_id) : undefined;
  const isAdminDaConta = Boolean(req.body?.is_admin_da_conta);

  if (!nome || !email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ status: 'erro', mensagem: 'nome e um e-mail válido são obrigatórios.' });
  }

  const existing = dbStore.tenantUsers.find(
    (user) => user.tenant_id === tenantId && user.email.trim().toLowerCase() === email
  );
  if (existing) {
    return res.status(409).json({
      status: 'erro',
      mensagem:
        existing.status === 'ATIVO'
          ? 'Já existe um usuário ativo com este e-mail nesta empresa.'
          : 'Já existe um convite pendente para este e-mail. Use reenviar convite.'
    });
  }

  const user: TenantUser = {
    id: uuidv4(),
    tenant_id: tenantId,
    nome,
    email,
    password_hash: await createUnavailablePasswordHash(),
    rbac_profile_id: rbacProfileId,
    is_admin_da_conta: isAdminDaConta,
    status: 'INATIVO',
    created_at: new Date().toISOString()
  };
  dbStore.tenantUsers.push(user);
  dbStore.persist();

  const tenant = dbStore.tenants.find((item) => item.id === tenantId)!;
  const invite = PortalIdentityService.createUserInvite(user);
  const mail = await sendPortalUserInviteEmail({
    to: email,
    token: invite.token,
    nome,
    razaoSocial: tenant.razao_social
  });

  const { password_hash, ...safeUser } = user;
  return res.status(201).json({
    status: 'sucesso',
    user: safeUser,
    convite: {
      enviado: mail.enviado,
      destino: email,
      expira_em: invite.expires_at,
      motivo: mail.motivo
    }
  });
});

router.post('/users/:id/resend-invite', authMiddleware, async (req: AuthenticatedRequest, res) => {
  if (!requireAccountAdmin(req, res)) return;
  const tenantId = req.tenant!.tenant_id;
  const user = dbStore.tenantUsers.find(
    (item) => item.id === req.params.id && item.tenant_id === tenantId
  );
  if (!user) {
    return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado.' });
  }
  if (user.status === 'ATIVO') {
    return res.status(409).json({
      status: 'erro',
      mensagem: 'Este usuário já ativou o acesso. Para trocar a senha, use “Esqueci minha senha”.'
    });
  }

  const tenant = dbStore.tenants.find((item) => item.id === tenantId)!;
  const invite = PortalIdentityService.createUserInvite(user);
  const mail = await sendPortalUserInviteEmail({
    to: user.email,
    token: invite.token,
    nome: user.nome,
    razaoSocial: tenant.razao_social
  });

  return res.json({
    status: 'sucesso',
    convite: {
      enviado: mail.enviado,
      destino: user.email,
      expira_em: invite.expires_at,
      motivo: mail.motivo
    }
  });
});

export default router;
