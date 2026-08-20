import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
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

export default router;
