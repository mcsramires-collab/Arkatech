import type { Policy, RamoApolice } from '../types';
import { dbStore } from './dbStore';
import {
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

function targetPoliciesFor(request: MigrationRequest): Policy[] {
  return dbStore.policies.filter(
    (policy) =>
      policy.tenant_id === request.tenant_id &&
      policy.insurer_id === request.requester_insurer_id &&
      policy.status === 'ATIVA'
  );
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
 * Nenhuma apólice de origem é alterada aqui. Efetivação continua sendo responsabilidade de
 * `OnboardingMigrationService.effectMigration`, que revalida data, origem e destinos de forma
 * atômica antes da troca.
 */
export function reconcileMigrationOnboardingForInsurer(insurerId: string): MigrationReconcileResult {
  const requests = onboardingMigrationService
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
      // Se houver histórico de mais de uma apólice ativa do mesmo ramo, não precisamos escolher
      // por valor/ordem de criação para autorizar averbação; `completeOnboarding` exige apenas um
      // destino válido por ramo. A escolha determinística pelo id evita resultado variável.
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
      onboardingMigrationService.completeOnboarding(request.id, insurerId, selectedIds);
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
