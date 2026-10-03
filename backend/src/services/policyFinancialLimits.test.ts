import { Policy } from '../types';
import { dbStore } from './dbStore';
import { PolicyFinancialLimitsService } from './policyFinancialLimits';

describe('PolicyFinancialLimitsService', () => {
  const previousCoverages = [...dbStore.insurerCoverages];
  const previousValues = [...dbStore.policyCoverageValues];

  const policy: Policy = {
    id: 'policy-lmi-test',
    numero_apolice: 'TESTE-LMI',
    ramo: 'RCTRC',
    tenant_id: 'tenant-lmi-test',
    insurer_id: 'insurer-lmi-test',
    broker_id: 'broker-lmi-test',
    status: 'ATIVA',
    permitir_inativo_vencido: false,
    aceita_averbacao_como_destinatario: false,
    vigencia_inicio: '2026-01-01T00:00:00.000Z',
    vigencia_fim: '2026-12-31T23:59:59.999Z',
    lmi: 1_000_000
  };

  beforeEach(() => {
    dbStore.insurerCoverages = [
      ...previousCoverages,
      {
        id: 'coverage-container',
        insurer_id: policy.insurer_id,
        titulo: 'Container',
        obrigatoria: false,
        aplicar_todos_clientes: true,
        tipo_valor: 'monetario',
        created_at: new Date().toISOString()
      },
      {
        id: 'coverage-info',
        insurer_id: policy.insurer_id,
        titulo: 'Observação',
        obrigatoria: false,
        aplicar_todos_clientes: true,
        tipo_valor: 'informativo',
        created_at: new Date().toISOString()
      }
    ];
    dbStore.policyCoverageValues = [
      ...previousValues,
      {
        id: 'value-container',
        policy_id: policy.id,
        insurer_coverage_id: 'coverage-container',
        valor: 150_000,
        desconta_lmi: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        id: 'value-info',
        policy_id: policy.id,
        insurer_coverage_id: 'coverage-info',
        valor: 999_999,
        desconta_lmi: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];
  });

  afterAll(() => {
    dbStore.insurerCoverages = previousCoverages;
    dbStore.policyCoverageValues = previousValues;
  });

  it('reduz o LMI disponível apenas por coberturas monetárias marcadas para desconto', () => {
    const result = PolicyFinancialLimitsService.calculateLmiAvailability(policy);

    expect(result.contractual_lmi).toBe(1_000_000);
    expect(result.reserved_lmi).toBe(150_000);
    expect(result.available_lmi).toBe(850_000);
    expect(result.reservations).toEqual([
      expect.objectContaining({ titulo: 'Container', valor: 150_000 })
    ]);
  });

  it('nunca deixa o LMI disponível negativo', () => {
    dbStore.policyCoverageValues.push({
      id: 'value-extra',
      policy_id: policy.id,
      insurer_coverage_id: 'coverage-container',
      valor: 2_000_000,
      desconta_lmi: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const result = PolicyFinancialLimitsService.calculateLmiAvailability(policy);
    expect(result.available_lmi).toBe(0);
  });
});
