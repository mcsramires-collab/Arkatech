import { Response } from 'express';
import { dbStore } from '../services/dbStore';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';

/**
 * Helpers de autorização compartilhados entre admin.ts, adminPacote2109.ts, adminSeguradora1.ts
 * e adminSeguradora2.ts — extraídos para arquivo próprio só por tamanho (admin.ts já passava de
 * 2000 linhas antes mesmo do pacote de 21/09; dividir em vários routers menores, todos montados
 * no mesmo prefixo /api/v1/admin, foi a forma de manter cada arquivo publicável sem mudar nenhum
 * comportamento real). Ver o comentário original completo (Fase 4 do item "Login real + RBAC" e
 * "requirePermission() por módulo") no topo de admin.ts.
 */

function resolveInsurerId(
  req: BackofficeAuthenticatedRequest,
  res: Response,
  insurerIdDaRequisicao: unknown
): string | null {
  const ator = req.backoffice;
  if (!ator) {
    res.status(401).json({ status: 'erro', mensagem: 'Autenticação de backoffice ausente.' });
    return null;
  }

  if (ator.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      res.status(403).json({
        status: 'erro',
        mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.'
      });
      return null;
    }
    return ator.insurer_id;
  }

  if (ator.actor_type === 'INTERNAL_USER') {
    if (!insurerIdDaRequisicao || typeof insurerIdDaRequisicao !== 'string') {
      res.status(400).json({ status: 'erro', mensagem: 'insurer_id é obrigatório.' });
      return null;
    }
    return insurerIdDaRequisicao;
  }

  res.status(403).json({
    status: 'erro',
    mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.'
  });
  return null;
}

/**
 * Para rotas escopadas por policy_id (regras/valores/sublimites/configs de UMA apólice
 * específica) em vez de insurer_id direto: confirma que a apólice pertence à seguradora
 * autenticada antes de deixar ler/escrever. ADM (real ou chave interna) continua sem restrição.
 */
function policyPertenceAoAtor(req: BackofficeAuthenticatedRequest, res: Response, policyId: unknown): boolean {
  const ator = req.backoffice;
  if (!ator) {
    res.status(401).json({ status: 'erro', mensagem: 'Autenticação de backoffice ausente.' });
    return false;
  }
  if (ator.actor_type === 'INTERNAL_USER') return true;
  if (ator.actor_type !== 'SEGURADORA') {
    res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
    return false;
  }
  if (!ator.insurer_id) {
    res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    return false;
  }
  if (!policyId || typeof policyId !== 'string') {
    res.status(400).json({ status: 'erro', mensagem: 'policy_id é obrigatório.' });
    return false;
  }
  const policy = dbStore.policies.find((p) => p.id === policyId);
  if (!policy || policy.insurer_id !== ator.insurer_id) {
    res.status(403).json({ status: 'erro', mensagem: 'Esta apólice não pertence à sua seguradora.' });
    return false;
  }
  return true;
}

/** Rotas de administração interna sem consumidor no Portal da Seguradora hoje — ver comentário acima. */
function apenasInternalUser(req: BackofficeAuthenticatedRequest, res: Response): boolean {
  if (req.backoffice?.actor_type === 'INTERNAL_USER') return true;
  res.status(403).json({
    status: 'erro',
    mensagem: 'Esta área é exclusiva da administração Arckatech.'
  });
  return false;
}

export { resolveInsurerId, policyPertenceAoAtor, apenasInternalUser };
