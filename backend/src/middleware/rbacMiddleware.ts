import { Response, NextFunction } from 'express';
import { dbStore } from '../services/dbStore';
import { RbacPermissionLevel } from '../types';
import { BackofficeAuthenticatedRequest } from './authMiddleware';

/**
 * Módulos cobertos por RbacProfile.permissions (types/index.ts) — mantido em sincronia manual
 * com aquele tipo, já que RbacProfile.permissions não é um Record<string, X> genérico.
 */
type RbacModulo =
  | 'apolices'
  | 'clientes'
  | 'coberturas'
  | 'relatorios'
  | 'usuarios'
  | 'delegacao_corretora';

const NIVEL_SUFICIENTE: Record<RbacPermissionLevel, RbacPermissionLevel[]> = {
  sem_acesso: [],
  ver: ['ver', 'editar'],
  editar: ['editar']
};

/**
 * Middleware factory: exige que quem chamou (via backofficeAuthMiddleware, aplicado antes deste
 * na cadeia) tenha pelo menos `nivelMinimo` no módulo `modulo`.
 *
 * Regras:
 *  - ADM da Arckatech (actor_type=INTERNAL_USER, role=ADM) tem acesso irrestrito — não passa por
 *    RbacProfile (é o "superusuário" documentado em internal.ts: "acesso irrestrito, sem as
 *    limitações de carteira que Seguradora/Corretora/Transportador têm").
 *  - Todo mundo mais (AGENTE, SEGURADORA, CORRETORA) precisa ter um `rbac_profile_id` válido
 *    apontando para um RbacProfile cujo `permissions[modulo]` atenda `nivelMinimo`.
 *  - Sem `req.backoffice` (middleware de auth não rodou antes) ou sem `rbac_profile_id`/perfil
 *    inexistente: nega por padrão (fail-closed), nunca assume acesso.
 *
 * ⚠️ Ainda não está aplicada a nenhuma rota — ver o comentário em backofficeAuthMiddleware sobre
 * por que o corte para JWT real em /admin e /broker precisa esperar as telas de login (item
 * "Login real + RBAC" no Backlog). Este helper existe pronto para quando isso acontecer.
 */
export function requirePermission(modulo: RbacModulo, nivelMinimo: RbacPermissionLevel) {
  return (req: BackofficeAuthenticatedRequest, res: Response, next: NextFunction) => {
    const ator = req.backoffice;
    if (!ator) {
      return res.status(401).json({
        status: 'erro',
        mensagem: 'Autenticação de backoffice ausente.'
      });
    }

    if (ator.actor_type === 'INTERNAL_USER' && ator.role === 'ADM') {
      return next();
    }

    if (!ator.rbac_profile_id) {
      return res.status(403).json({
        status: 'erro',
        mensagem: 'Usuário sem perfil de acesso (RbacProfile) atribuído — sem permissão para esta ação.'
      });
    }

    const perfil = dbStore.rbacProfiles.find((p) => p.id === ator.rbac_profile_id);
    if (!perfil) {
      return res.status(403).json({
        status: 'erro',
        mensagem: 'Perfil de acesso não encontrado — sem permissão para esta ação.'
      });
    }

    const nivelAtual = perfil.permissions[modulo];
    if (!NIVEL_SUFICIENTE[nivelMinimo].includes(nivelAtual)) {
      return res.status(403).json({
        status: 'erro',
        mensagem: `Seu perfil de acesso ("${perfil.nome_perfil}") não tem permissão de "${nivelMinimo}" em "${modulo}".`
      });
    }

    return next();
  };
}
