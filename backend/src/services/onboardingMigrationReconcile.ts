import type { Policy, RamoApolice } from '../types';
import { dbStore } from './dbStore';
import {
  OnboardingMigrationService,
  onboardingMigrationService,
  type MigrationRequest,
  type MigrationRamoCode
} from './onboardingMigration';

const CODE_TO_RAMO: Record<MigrationRamoCode, RamoApolice> = {
  '54': 'RCTRC',
  '55': 'RCDC',
  '59': 'RCV'
};

export interface MigrationReconcileResult {
  inspected: number;
  completed: string[];
  skipped: Array<{ request_id: string; reason: string }>;
}

export interface MigrationEffectResult {
  inspected: number;
  effected: string[];
  skipped: Array<{ request_id: string; reason: string }>;
}

function targetPoliciesFor(request: MigrationRequest): Policy[] {
  return dbStore.policies.filter(
    (policy) =>
      policy.tenant_id === request.tenant_id &&
      policy.insurer_id === request.requester_insurer_id &&
      policy.status === 'ATIVA'
  );
}

function saoPauloDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** Compara por data civil da operação, sem antecipar a virada às 21h do dia anterior no Brasil. */
export function isMigrationDueAt(scheduledStart: string | undefined, now = new Date()): boolean {
  if (!scheduledStart) return true;
  return saoPauloDate(now) >= scheduledStart.slice(0, 10);
}

/**
 * Reconciliador idempotente entre o wizard de cadastro/apólices e o domínio de migração.
 *
 * O Portal cria a primeira apólice via POST /admin/insurer-clients e as seguintes via
 * POST /admin/policies. Em vez de obrigar o frontend legado a juntar IDs e chamar um terceiro
 * endpoint no instante exato, este helper verifica o estado canônico do backend depois de uma
 * mutação bem-sucedida. A migração só fica `onboarding_completed=true` quando existe pelo menos
 * UMA apólice ativa da seguradora recebedora, no mesmo tenant, para CADA ramo selecionado.
 *
 * Nenhuma apólice de origem é alterada aqui. Efetivação é feita pela rotina abaixo, que revalida
 * data, origem e destinos no `OnboardingMigrationService.effectMigration`.
 */
export function reconcileMigrationOnboardingForInsurer(
  insurerId: string,
  service: OnboardingMigrationService = onboardingMigrationService
): MigrationReconcileResult {
  const requests = service
    .listRequests(insurerId)
    .filter((request) => request.status === 'PROGRAMADA' && !request.onboarding_completed);

  const result: MigrationReconcileResult = {
    inspected: requests.length,
    completed: [],
    skipped: []
  };

  for (const request of requests) {
    const candidates = targetPoliciesFor(request);
    const selectedIds: string[] = [];
    let missing: MigrationRamoCode | undefined;

    for (const code of request.selected_ramos) {
      const ramo = CODE_TO_RAMO[code];
      const matches = candidates
        .filter((policy) => policy.ramo === ramo)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!matches.length) {
        missing = code;
        break;
      }
      selectedIds.push(matches[0]!.id);
    }

    if (missing) {
      result.skipped.push({
        request_id: request.id,
        reason: `Aguardando apólice ativa de destino para o ramo ${missing}.`
      });
      continue;
    }

    try {
      service.completeOnboarding(request.id, insurerId, selectedIds);
      result.completed.push(request.id);
    } catch (error) {
      result.skipped.push({
        request_id: request.id,
        reason: error instanceof Error ? error.message : 'Falha ao reconciliar onboarding.'
      });
    }
  }

  return result;
}

/**
 * Efetiva migrações vencidas somente quando o onboarding já está completo. A função é idempotente:
 * itens EFETIVADA deixam de entrar na seleção. `effectMigration` continua sendo a segunda barreira
 * e revalida os destinos e a existência das apólices de origem antes de inativar qualquer ramo.
 */
export function effectDueMigrationsForInsurer(
  insurerId: string,
  now = new Date(),
  service: OnboardingMigrationService = onboardingMigrationService
): MigrationEffectResult {
  const requests = service
    .listRequests(insurerId)
    .filter(
      (request) =>
        request.status === 'PROGRAMADA' &&
        request.onboarding_completed &&
        isMigrationDueAt(request.scheduled_start, now)
    );

  const result: MigrationEffectResult = {
    inspected: requests.length,
    effected: [],
    skipped: []
  };

  for (const request of requests) {
    try {
      service.effectMigration(request.id, insurerId, now);
      result.effected.push(request.id);
    } catch (error) {
      result.skipped.push({
        request_id: request.id,
        reason: error instanceof Error ? error.message : 'Falha ao efetivar migração programada.'
      });
    }
  }

  return result;
}

/** Executa a virada para todas as seguradoras antes do motor processar uma nova averbação. */
export function effectAllDueMigrations(now = new Date()): MigrationEffectResult {
  const aggregate: MigrationEffectResult = { inspected: 0, effected: [], skipped: [] };
  for (const insurer of dbStore.insurers) {
    const current = effectDueMigrationsForInsurer(insurer.id, now);
    aggregate.inspected += current.inspected;
    aggregate.effected.push(...current.effected);
    aggregate.skipped.push(...current.skipped);
  }
  return aggregate;
}
