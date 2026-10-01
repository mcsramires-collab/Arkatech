import type { Response, NextFunction } from 'express';
import type { BackofficeAuthenticatedRequest } from './authMiddleware';
import { dbStore } from '../services/dbStore';
import { reconcileMigrationOnboardingForInsurer } from '../services/onboardingMigrationReconcile';

function mutationCanCreateTargetPolicy(req: BackofficeAuthenticatedRequest): boolean {
  if (req.method !== 'POST') return false;
  const requestPath = req.path.replace(/\/+$/, '') || '/';
  return (
    requestPath === '/policies' ||
    requestPath === '/insurer-clients' ||
    /^\/insurer-clients\/[^/]+\/assume-policy$/.test(requestPath)
  );
}

function resolveMutationInsurer(req: BackofficeAuthenticatedRequest): string | undefined {
  const actor = req.backoffice;
  if (actor?.actor_type === 'SEGURADORA' && actor.insurer_id) return actor.insurer_id;

  // Administração Arckatech continua podendo criar em nome de uma seguradora; neste caso o
  // handler existente já valida o insurer_id do body. Só reconciliamos se esse ID existe.
  if (actor?.actor_type === 'INTERNAL_USER') {
    const bodyInsurerId = typeof req.body?.insurer_id === 'string' ? req.body.insurer_id : undefined;
    if (bodyInsurerId && dbStore.insurers.some((item) => item.id === bodyInsurerId)) return bodyInsurerId;
  }

  return undefined;
}

/**
 * Observa somente as mutações que podem criar/assumir uma apólice de destino. A reconciliação
 * roda DEPOIS de a resposta terminar e somente em respostas 2xx, portanto um 409 de conflito,
 * um 403 de permissão ou qualquer falha de validação nunca muda o MigrationRequest.
 */
export function onboardingMigrationReconcileMiddleware(
  req: BackofficeAuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (!mutationCanCreateTargetPolicy(req)) return next();

  const insurerId = resolveMutationInsurer(req);
  if (!insurerId) return next();

  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      const result = reconcileMigrationOnboardingForInsurer(insurerId);
      if (result.completed.length > 0) {
        console.info('[onboardingMigration] onboarding reconciliado após criação de apólice', {
          insurer_id: insurerId,
          completed_request_ids: result.completed
        });
      }
    } catch (error) {
      // A criação da apólice já foi concluída com sucesso; uma falha de reconciliação não pode
      // transformar retrospectivamente a resposta em erro. O próximo create/list pode tentar de
      // novo porque o reconciliador é idempotente.
      console.error('[onboardingMigration] falha ao reconciliar onboarding pós-mutação', error);
    }
  });

  return next();
}
