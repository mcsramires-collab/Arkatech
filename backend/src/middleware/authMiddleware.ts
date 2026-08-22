import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ResponseEngine } from '../services/responseEngine';
import { getJwtSecret } from '../utils/jwtSecret';

export interface AuthenticatedRequest extends Request {
  tenant?: {
    tenant_id: string;
    cnpj: string;
    razao_social: string;
    ambiente: 'teste' | 'producao';
    role: string;
    // Presentes só em tokens emitidos por POST /auth/portal-login (login por pessoa, usado
    // pelo Portal do Segurado). Tokens emitidos por POST /auth/token (client_id/client_secret,
    // usado por integrações máquina-a-máquina) não carregam identidade de usuário individual.
    tenant_user_id?: string;
    tenant_user_nome?: string;
    is_admin_da_conta?: boolean;
  };
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const errFormat = ResponseEngine.formatResponse('ERR-4001');
    return res.status(401).json({
      status: 'erro',
      codigo: errFormat.codigo,
      mensagem: errFormat.mensagem
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    req.tenant = {
      tenant_id: decoded.tenant_id,
      cnpj: decoded.cnpj,
      razao_social: decoded.razao_social,
      ambiente: decoded.ambiente,
      role: decoded.role,
      tenant_user_id: decoded.tenant_user_id,
      tenant_user_nome: decoded.tenant_user_nome,
      is_admin_da_conta: decoded.is_admin_da_conta
    };
    next();
  } catch (err) {
    const errFormat = ResponseEngine.formatResponse('ERR-4001');
    return res.status(401).json({
      status: 'erro',
      codigo: errFormat.codigo,
      mensagem: 'Token de autenticação inválido ou expirado.'
    });
  }
}
