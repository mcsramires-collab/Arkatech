import { dbStore } from './dbStore';
import { TestLabRunnerService } from './testLabRunner';

describe('TestLabRunnerService', () => {
  const originalRuns = dbStore.testLabRuns;

  afterEach(() => {
    dbStore.testLabRuns = originalRuns;
  });

  test('planeja somente P0/P1 e estima matriz combinatória', () => {
    const plan = TestLabRunnerService.plan({ mode: 'STANDARD' });

    expect(plan.total_scenarios).toBeGreaterThan(0);
    expect(plan.p0).toBeGreaterThan(0);
    expect(plan.p1).toBeGreaterThan(0);
    expect(plan.scenarios.every((scenario) => scenario.priority === 'P0' || scenario.priority === 'P1')).toBe(true);
    expect(plan.estimated_cartesian_cases).toBeGreaterThanOrEqual(plan.estimated_pairwise_cases);
  });

  test('modo QUICK mantém somente cenários críticos executáveis', () => {
    const plan = TestLabRunnerService.plan({ mode: 'QUICK' });
    expect(plan.total_scenarios).toBeGreaterThan(0);
    expect(plan.scenarios.some((scenario) => scenario.id === 'P0-ACCESS-INSURER-POLICY-ISOLATION')).toBe(true);
  });

  test('executa suíte P0 de isolamento e não deixa estado sintético no dbStore', async () => {
    const tenantsBefore = JSON.stringify(dbStore.tenants);
    const policiesBefore = JSON.stringify(dbStore.policies);
    const averbacoesBefore = JSON.stringify(dbStore.averbacoes);

    const run = await TestLabRunnerService.execute({
      mode: 'STANDARD',
      suite_keys: ['p0-access-isolation']
    });

    expect(run.status).toBe('COMPLETED');
    expect(run.failed).toBe(0);
    expect(run.gaps).toBe(0);
    expect(run.scenario_results.every((result) => result.status === 'PASS')).toBe(true);

    expect(JSON.stringify(dbStore.tenants)).toBe(tenantsBefore);
    expect(JSON.stringify(dbStore.policies)).toBe(policiesBefore);
    expect(JSON.stringify(dbStore.averbacoes)).toBe(averbacoesBefore);
  });

  test('exporta relatório CSV de uma execução', async () => {
    const run = await TestLabRunnerService.execute({
      mode: 'QUICK',
      suite_keys: ['p0-access-isolation']
    });
    const csv = TestLabRunnerService.exportCsv(run.id);
    expect(csv).toContain('scenario_id');
    expect(csv).toContain('P0-ACCESS-INSURER-POLICY-ISOLATION');
  });
});
