import { Policy } from '../types';
import { dbStore } from './dbStore';

export interface PolicyLmiReservation {
  coverage_value_id: string;
  insurer_coverage_id: string;
  titulo: string;
  valor: number;
}

export interface PolicyLmiAvailability {
  contractual_lmi?: number;
  reserved_lmi: number;
  available_lmi?: number;
  reservations: PolicyLmiReservation[];
}

/**
 * Calcula o LMI efetivamente disponível para novas averbações.
 *
 * `PolicyCoverageValue.desconta_lmi` representa uma reserva fixa da cobertura adicional dentro
 * do LMI contratual da apólice. A reserva NÃO aumenta o valor da carga/documento e, por isso,
 * não deve ser somada em `valor_considerado_averbacao`; ela reduz somente o limite financeiro
 * disponível usado pela barreira de LMI do motor.
 *
 * Só entram no cálculo coberturas monetárias válidas da mesma seguradora. Registros órfãos ou
 * coberturas meramente informativas são ignorados defensivamente, evitando reduzir limite por
 * configuração inconsistente.
 */
export class PolicyFinancialLimitsService {
  static calculateLmiAvailability(policy: Policy): PolicyLmiAvailability {
    const reservations = dbStore.policyCoverageValues
      .filter((value) => value.policy_id === policy.id && value.desconta_lmi)
      .map((value): PolicyLmiReservation | undefined => {
        const coverage = dbStore.insurerCoverages.find(
          (item) =>
            item.id === value.insurer_coverage_id &&
            item.insurer_id === policy.insurer_id &&
            item.tipo_valor === 'monetario'
        );
        const amount = Number(value.valor);
        if (!coverage || !Number.isFinite(amount) || amount <= 0) return undefined;

        return {
          coverage_value_id: value.id,
          insurer_coverage_id: coverage.id,
          titulo: coverage.titulo,
          valor: amount
        };
      })
      .filter((item): item is PolicyLmiReservation => Boolean(item));

    const reservedLmi = reservations.reduce((sum, item) => sum + item.valor, 0);
    const contractualLmi = policy.lmi;

    return {
      contractual_lmi: contractualLmi,
      reserved_lmi: reservedLmi,
      available_lmi:
        contractualLmi === undefined ? undefined : Math.max(0, contractualLmi - reservedLmi),
      reservations
    };
  }
}
