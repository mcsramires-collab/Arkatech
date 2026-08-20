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
      role: decoded.role
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
