import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ResponseEngine } from '../services/responseEngine';
import { getJwtSecret } from '../utils/jwtSecret';
import { BackofficeAuthenticatedRequest } from './authMiddleware';

/**
 * Fase 3 do item "Login real + RBAC" (Backlog, seção 4) — substitui `internalApiKeyMiddleware`
 * em `/admin` e `/broker` por este middleware combinado, sem quebrar nada em produção:
 *
 * 1) Se vier `Authorization: Bearer <token>` válido (emitido por POST /auth/backoffice-login),
 *    autentica como a PESSOA real (ADM/Agente Arckatech, ou usuário de Seguradora/Corretora) e
 *    popula `req.backoffice` com a identidade real — é isso que rotas migradas (ver `broker.ts`,
 *    já migrado nesta mesma fase) usam para derivar `insurer_id`/`broker_id` em vez de aceitar
 *    livre em query/body.
 * 2) Senão, se vier `x-internal-api-key` válida, autentica como um ator ADM sintético — mesmo
 *    nível de acesso irrestrito que o painel já tinha antes desta fase. Isso existe só para não
 *    quebrar o BFF dos portais enquanto a troca de `SEED_INSURER_ID`/`SEED_BROKER_ID` por dados
 *    reais da sessão em `admin.ts` (Fase 4, ainda pendente para esse arquivo — ver Backlog) não
 *    foi feita. `broker.ts` já não depende mais deste caminho para nada além do papel ADM.
 * 3) Se nenhum dos dois vier — ou o Bearer vier presente mas inválido/expirado e não houver
 *    `x-internal-api-key` válida como alternativa — nega com 401.
 *
 * Quando a Fase 4 terminar de migrar `admin.ts` para nunca mais aceitar `insurer_id` livre, o
 * passo 2 (chave interna) deixa de ser necessário para `/admin` e `/broker` e pode ser removido
 * — ele existe só como ponte durante a migração, mantendo o BFF (que hoje só envia a chave
 * interna, mais o Bearer da sessão quando existe — ver `api.server.ts` no frontend) funcionando
 * o tempo todo.
 */
const SYNTHETIC_INTERNAL_KEY_ACTOR: NonNullable<BackofficeAuthenticatedRequest['backoffice']> = {
  actor_type: 'INTERNAL_USER',
  user_id: 'system:internal-api-key',
  nome: 'Sistema (chave interna)',
  email: '',
  role: 'ADM'
};

function tentarAutenticarBearer(req: BackofficeAuthenticatedRequest): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    if (!decoded.actor_type) return false; // token de outro contexto (ex: /auth/token, /portal-login)
    req.backoffice = {
      actor_type: decoded.actor_type,
      user_id: decoded.user_id,
      nome: decoded.nome,
      email: decoded.email,
      role: decoded.role,
      rbac_profile_id: decoded.rbac_profile_id,
      tenant_id: decoded.tenant_id,
      insurer_id: decoded.insurer_id,
      broker_id: decoded.broker_id
    };
    return true;
  } catch {
    return false;
  }
}

function tentarAutenticarChaveInterna(req: BackofficeAuthenticatedRequest): boolean {
  const expectedKey = process.env.INTERNAL_API_KEY;
  if (!expectedKey) return false;

  const providedKey = req.headers['x-internal-api-key'];
  if (!providedKey || providedKey !== expectedKey) return false;

  req.backoffice = SYNTHETIC_INTERNAL_KEY_ACTOR;
  return true;
}

export function backofficeOrInternalKeyMiddleware(
  req: BackofficeAuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (tentarAutenticarBearer(req)) return next();
  if (tentarAutenticarChaveInterna(req)) return next();

  const errFormat = ResponseEngine.formatResponse('ERR-4001');
  return res.status(401).json({
    status: 'erro',
    codigo: errFormat.codigo,
    mensagem:
      'Autenticação ausente ou inválida — informe "Authorization: Bearer <token>" (login) ou "x-internal-api-key" (chave interna).'
  });
}
