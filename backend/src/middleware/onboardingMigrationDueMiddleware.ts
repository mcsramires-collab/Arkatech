import type { Request, Response, NextFunction } from 'express';
import { effectAllDueMigrations } from '../services/onboardingMigrationReconcile';

/**
 * Barreira operacional antes do motor de averbação: se uma migração programada já venceu pela
 * data civil de São Paulo e o onboarding está completo, a troca de apólice é efetivada ANTES de
 * qualquer novo documento ser processado. Assim a correção não depende de alguém abrir o portal.
 */
export function onboardingMigrationDueMiddleware(_req: Request, _res: Response, next: NextFunction) {
  try {
    const result = effectAllDueMigrations();
    if (result.effected.length > 0) {
      console.info('[onboardingMigration] migrações programadas efetivadas antes da averbação', {
        request_ids: result.effected
      });
    }
    if (result.skipped.length > 0) {
      console.warn('[onboardingMigration] migrações vencidas não efetivadas', {
        skipped: result.skipped
      });
    }
  } catch (error) {
    // Fail closed quanto à troca: em caso de erro não inventamos estado novo. O motor ainda possui
    // as próprias validações de apólice, e a falha fica observável para correção operacional.
    console.error('[onboardingMigration] falha ao verificar migrações vencidas', error);
  }
  return next();
}
