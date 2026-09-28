import { dbStore } from './dbStore';
import { InsurerVisibilityService } from './insurerVisibilityService';

describe('InsurerVisibilityService', () => {
  const originalPolicies = dbStore.policies;
  const originalAverbacoes = dbStore.averbacoes;

  afterEach(() => {
    dbStore.policies = originalPolicies;
    dbStore.averbacoes = originalAverbacoes;
  });

  test('isola averbações pelo insurer_id da apólice, mesmo para o mesmo segurado e ramo', () => {
    const tenantId = 'lab-shared-tenant';

    dbStore.policies = [
      {
        id: 'lab-pol-a',
        numero_apolice: 'A-001',
        ramo: 'RCTRC',
        tenant_id: tenantId,
        insurer_id: 'lab-ins-a',
        broker_id: 'lab-broker',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z',
        vigencia_fim: '2027-01-01T00:00:00.000Z',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'lab-pol-b',
        numero_apolice: 'B-001',
        ramo: 'RCTRC',
        tenant_id: tenantId,
        insurer_id: 'lab-ins-b',
        broker_id: 'lab-broker',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z',
        vigencia_fim: '2027-01-01T00:00:00.000Z',
        aceita_averbacao_como_destinatario: false
      }
    ] as any;

    dbStore.averbacoes = [
      {
        id: 'lab-avb-a',
        policy_id: 'lab-pol-a',
        tenant_id: tenantId,
        status: 'SUCESSO',
        valor_carga: 1000,
        valor_considerado_averbacao: 1000,
        created_at: '2026-09-28T10:00:00.000Z'
      },
      {
        id: 'lab-avb-b',
        policy_id: 'lab-pol-b',
        tenant_id: tenantId,
        status: 'SUCESSO',
        valor_carga: 3000,
        valor_considerado_averbacao: 3000,
        created_at: '2026-09-28T10:01:00.000Z'
      }
    ] as any;

    expect(InsurerVisibilityService.averbacoes('lab-ins-a').map((item) => item.id))
      .toEqual(['lab-avb-a']);
    expect(InsurerVisibilityService.averbacoes('lab-ins-b').map((item) => item.id))
      .toEqual(['lab-avb-b']);

    expect(InsurerVisibilityService.canAccessAverbacao('lab-ins-a', 'lab-avb-a')).toBe(true);
    expect(InsurerVisibilityService.canAccessAverbacao('lab-ins-a', 'lab-avb-b')).toBe(false);

    expect(InsurerVisibilityService.aggregate('lab-ins-a').valor_total_averbado).toBe(1000);
    expect(InsurerVisibilityService.aggregate('lab-ins-b').valor_total_averbado).toBe(3000);
  });
});
