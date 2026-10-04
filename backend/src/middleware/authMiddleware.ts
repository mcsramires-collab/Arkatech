import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ResponseEngine } from '../services/responseEngine';
import { getJwtSecret } from '../utils/jwtSecret';
import { getPortalSessionVersion } from '../utils/portalSessionVersion';
import { dbStore } from '../services/dbStore';
import { PortalIdentityService } from '../services/portalIdentityService';

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

    // Tokens pessoais do Portal do Segurado deixam de ser válidos imediatamente quando o
    // TenantUser é inativado/removido ou quando uma redefinição de senha é concluída. Tokens
    // máquina-a-máquina de /auth/token não têm tenant_user_id e continuam pelo fluxo legado.
    if (decoded.tenant_user_id) {
      const user = dbStore.tenantUsers.find(
        (item) => item.id === decoded.tenant_user_id && item.tenant_id === decoded.tenant_id
      );
      if (!user || user.status !== 'ATIVO') {
        throw new Error('usuário do portal inexistente ou inativo');
      }
      if (decoded.portal_session_version !== undefined) {
        if (decoded.portal_session_version !== getPortalSessionVersion(user)) {
          throw new Error('sessão anterior à troca de credencial');
        }
      } else if (PortalIdentityService.isPortalSessionStale(user.id, decoded.iat)) {
        // JWTs legados seguem o corte conservador em milissegundos. Não arredondar:
        // isso poderia revalidar sessões emitidas antes do reset no mesmo segundo.
        throw new Error('sessão anterior à troca de senha');
      }
    }

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
      mensagem: 'Token de autenticação inválido, expirado ou revogado. Faça login novamente.'
    });
  }
}

/**
 * Payload de quem loga via POST /auth/backoffice-login — ADM/AGENTE (Arckatech), ou pessoa de
 * uma Seguradora/Corretora (TenantUser com tenant.role SEGURADORA/CORRETORA). Deliberadamente
 * separado de `AuthenticatedRequest.tenant` acima (usado só pelo Portal do Segurado) porque o
 * "dono" aqui pode ser Insurer/Broker, não só Tenant — ver RbacProfile.owner_id em types/index.ts.
 *
 * ⚠️ Este middleware ainda NÃO está montado em /admin nem /broker (ver server.ts) — essas rotas
 * continuam protegidas só por internalApiKeyMiddleware. Ligar este middleware ali é um corte que
 * só pode acontecer junto da tela de login real em cada portal (ver Backlog, item "Login real +
 * RBAC"): sem tela de login, nenhum front hoje sabe emitir/enviar um Bearer token para /admin ou
 * /broker, e trocar a proteção agora derrubaria os dois portais em produção.
 */
export interface BackofficeAuthenticatedRequest extends Request {
  backoffice?: {
    actor_type: 'INTERNAL_USER' | 'SEGURADORA' | 'CORRETORA';
    user_id: string;
    nome: string;
    email: string;
    role: string; // InternalUserRole ('ADM'|'AGENTE') quando actor_type=INTERNAL_USER; UserRole ('SEGURADORA'|'CORRETORA') caso contrário
    rbac_profile_id?: string;
    tenant_id?: string; // Tenant.id — só para SEGURADORA/CORRETORA
    insurer_id?: string; // Insurer.id — só para actor_type=SEGURADORA
    broker_id?: string; // Broker.id — só para actor_type=CORRETORA
    partner_type?: 'CORRETORA' | 'ASSESSORIA' | 'AMBOS'; // classificação comercial do Broker
    // Fase 5 (item 3) — Login real + RBAC: presentes só em tokens emitidos por
    // POST /auth/backoffice-login (têm claims jti/exp reais); o ator sintético da chave interna
    // (ver backofficeOrInternalKeyMiddleware) não tem token nenhum por trás, então fica sem os
    // dois — nada usa jti/exp para esse ator, e não faz sentido "revogar" uma chave compartilhada
    // por aqui (ela é rotacionada manualmente, ver Backlog seção 1).
    jti?: string;
    exp?: number; // epoch SECONDS (claim padrão do JWT), não ms — converter ao usar com Date.now()
  };
}

export function backofficeAuthMiddleware(
  req: BackofficeAuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
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
    if (!decoded.actor_type) {
      // Token válido, mas não foi emitido por /auth/backoffice-login (ex: token de /auth/token
      // ou /auth/portal-login usado no lugar errado) — trata como inválido para este contexto.
      throw new Error('token sem actor_type — não é um token de backoffice');
    }
    // Fase 5 (item 3) — revogação: mesmo com assinatura válida e ainda não vencido, um token cujo
    // jti foi explicitamente revogado (hoje só via logout real) não autentica mais nada.
    if (dbStore.isTokenRevoked(decoded.jti)) {
      throw new Error('token revogado');
    }
    req.backoffice = {
      actor_type: decoded.actor_type,
      user_id: decoded.user_id,
      nome: decoded.nome,
      email: decoded.email,
      role: decoded.role,
      rbac_profile_id: decoded.rbac_profile_id,
      tenant_id: decoded.tenant_id,
      insurer_id: decoded.insurer_id,
      broker_id: decoded.broker_id,
      partner_type: decoded.partner_type,
      jti: decoded.jti,
      exp: decoded.exp
    };
    next();
  } catch (err) {
    const errFormat = ResponseEngine.formatResponse('ERR-4001');
    return res.status(401).json({
      status: 'erro',
      codigo: errFormat.codigo,
      mensagem: 'Token de autenticação inválido, expirado ou revogado. Faça login novamente.'
    });
  }
}
