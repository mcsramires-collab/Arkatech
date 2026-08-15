import { Request, Response, NextFunction } from 'express';

/**
 * Proteção mínima para os painéis internos (/admin, /broker, /internal) enquanto
 * não existe login real (usuário/senha + sessão) para Seguradora/Corretora/ADM.
 * Exige um cabeçalho x-internal-api-key batendo com a variável de ambiente
 * INTERNAL_API_KEY. Não é RBAC completo — é uma trava de "só quem tem a chave
 * do painel entra", para impedir acesso público não autenticado à API.
 *
 * Quando o login de verdade (tenant_users + rbac_profiles) for implementado,
 * este middleware deve ser substituído por uma checagem de sessão por usuário.
 */
export function internalApiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const expectedKey = process.env.INTERNAL_API_KEY;

  if (!expectedKey) {
    // Sem a variável configurada, não há como validar — bloqueia por segurança
    // em vez de deixar passar silenciosamente.
    return res.status(500).json({
      status: 'erro',
      mensagem: 'INTERNAL_API_KEY não configurada no servidor. Acesso aos painéis internos bloqueado.'
    });
  }

  const providedKey = req.headers['x-internal-api-key'];

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({
      status: 'erro',
      mensagem: 'Chave de acesso ao painel interno ausente ou inválida.'
    });
  }

  next();
}
