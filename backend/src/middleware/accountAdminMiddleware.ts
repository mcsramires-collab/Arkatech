import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from './authMiddleware';
import { dbStore } from '../services/dbStore';

/** Portal do Segurado: administrar usuários exige uma pessoa administradora da própria conta. */
export function requireAccountAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const actor = req.tenant;
  // A claim identifica a sessão humana; o cadastro atual revoga o poder de um admin
  // despromovido sem esperar a expiração do JWT. Perfis de backoffice não concedem esse poder.
  const user = actor?.tenant_user_id
    ? dbStore.tenantUsers.find(item => item.id === actor.tenant_user_id && item.tenant_id === actor.tenant_id)
    : undefined;

  if (actor?.is_admin_da_conta !== true || user?.is_admin_da_conta !== true || user.status !== 'ATIVO') {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'Somente um administrador humano da conta pode gerenciar usuários.'
    });
  }
  return next();
}
