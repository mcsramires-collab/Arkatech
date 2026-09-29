import { dbStore } from './dbStore';
import { TestLabRunnerService } from './testLabRunner';
import { TestLabScenarioGenerator as Generator } from './testLabScenarioGenerator';
import { MockGeneratorService } from './mockGenerator';
import { TestLabFixtureGenerator } from './testLabFixtureGenerator';
import { TestLabSafetyService } from './testLabSafety';

describe('Test Lab safety and regression guarantees', () => {
  test('concurrent sandboxes and ordinary requests cannot see or overwrite one another', async () => {
    const original = dbStore.tenants;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = dbStore.runTestLabEphemeral(async () => {
      dbStore.tenants = [{ id: 'first' }] as any;
      await pending;
      expect(dbStore.tenants[0]!.id).toBe('first');
    });
    expect(dbStore.tenants).toBe(original);
    await dbStore.runTestLabEphemeral(async () => {
      dbStore.tenants = [{ id: 'second' }] as any;
      await dbStore.runTestLabEphemeral(async () => { dbStore.tenants = []; });
      expect(dbStore.tenants[0]!.id).toBe('second');
    });
    release(); await first;
    expect(dbStore.tenants).toBe(original);
  });

  test('exceptions discard every collection, including users and permissions', async () => {
    const original = dbStore.internalUsers;
    await expect(dbStore.runTestLabEphemeral(async () => {
      dbStore.internalUsers = [{ id: 'synthetic-user' }] as any;
      throw new Error('intentional');
    })).rejects.toThrow('intentional');
    expect(dbStore.internalUsers).toBe(original);
  });

  test('production is blocked before history or data can be modified without explicit opt-in', async () => {
    const env = process.env.NODE_ENV;
    const enabled = process.env.TEST_LAB_ENABLED;
    const runs = dbStore.testLabRuns.length;
    process.env.NODE_ENV = 'production';
    delete process.env.TEST_LAB_ENABLED;
    try {
      await expect(TestLabRunnerService.execute()).rejects.toThrow('TEST_LAB_PRODUCTION_BLOCKED');
    } finally {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      if (enabled === undefined) delete process.env.TEST_LAB_ENABLED;
      else process.env.TEST_LAB_ENABLED = enabled;
    }
    expect(dbStore.testLabRuns).toHaveLength(runs);
  });

  test('production runtime allows the isolated Test Lab only with TEST_LAB_ENABLED=true', async () => {
    const env = process.env.NODE_ENV;
    const enabled = process.env.TEST_LAB_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.TEST_LAB_ENABLED = 'true';
    try {
      expect(TestLabSafetyService.status()).toMatchObject({
        execution_allowed: true,
        production_like_runtime: true,
        explicit_opt_in: true
      });
      const run = await TestLabRunnerService.execute({
        mode: 'QUICK',
        suite_keys: ['p0-access-isolation']
      });
      expect(run.status).toBe('COMPLETED');
      expect(run.failed).toBe(0);
    } finally {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      if (enabled === undefined) delete process.env.TEST_LAB_ENABLED;
      else process.env.TEST_LAB_ENABLED = enabled;
    }
  });

  test('TEST_LAB_ENABLED=false disables execution even in development', () => {
    const env = process.env.NODE_ENV;
    const enabled = process.env.TEST_LAB_ENABLED;
    process.env.NODE_ENV = 'development';
    process.env.TEST_LAB_ENABLED = 'false';
    try {
      expect(TestLabSafetyService.status()).toMatchObject({
        execution_allowed: false,
        explicit_disabled: true,
        reason: 'TEST_LAB_DISABLED'
      });
      expect(() => TestLabSafetyService.assertExecutionAllowed()).toThrow('TEST_LAB_DISABLED');
    } finally {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      if (enabled === undefined) delete process.env.TEST_LAB_ENABLED;
      else process.env.TEST_LAB_ENABLED = enabled;
    }
  });

  test('unknown, empty and invalid selections never silently execute the default suite', () => {
    expect(() => TestLabRunnerService.plan({ suite_keys: [] })).toThrow();
    expect(() => TestLabRunnerService.plan({ selected_flag_keys: ['unknown'] })).toThrow();
    expect(() => TestLabRunnerService.plan({ mode: 'invalid' as any })).toThrow();
    expect(() => TestLabRunnerService.plan({ only_scenario_ids: ['removed-scenario'] })).toThrow('TEST_LAB_UNKNOWN_SCENARIO');
  });

  test('large pairwise matrix covers every pair with complete assignments', () => {
    const dimensions = Array.from({ length: 14 }, (_, i) => ({ key: 'd' + i, values: [false, true] }));
    const rows = Generator.pairwise(dimensions, 5);
    expect(rows).toEqual(Generator.pairwise(dimensions, 5));
    expect(rows.every(row => Object.keys(row).length === 14)).toBe(true);
    for (let i = 0; i < 14; i++) for (let j = i + 1; j < 14; j++) {
      for (const a of [false,true]) for (const b of [false,true]) expect(rows.some(r => r['d'+i] === a && r['d'+j] === b)).toBe(true);
    }
    expect(() => Generator.cartesian(dimensions, 5)).toThrow('TEST_LAB_MATRIX_LIMIT');
  });

  test('rerun selects only failures and preserves the link to the original execution', async () => {
    const run = await TestLabRunnerService.execute({ mode: 'QUICK', suite_keys: ['p0-access-isolation'] });
    await expect(TestLabRunnerService.rerunFailed(run.id)).rejects.toThrow('TEST_LAB_NO_FAILED_SCENARIOS');
    run.scenario_results[0]!.status = 'FAIL';
    run.failed = 1;
    const rerun = await TestLabRunnerService.rerunFailed(run.id);
    expect(rerun.rerun_of).toBe(run.id);
    expect(rerun.scenario_results.map(result => result.id)).toEqual([run.scenario_results[0]!.id]);
    expect(rerun.failed).toBe(0);
  });

  test('all document fixtures, including MDF-e insurance number, are deterministic', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      dbStore.tenants = [{ id: 'fixture', cnpj: '12345678000190', razao_social: 'TEST', ambiente: 'teste' }] as any;
      for (const tipoDoc of ['CTE','NFE','MDFE','NFSE'] as const) {
        const generator = new TestLabFixtureGenerator('repeatable-seed');
        const seeded = generator.xml({ tenantId: 'fixture', tipoDoc }, 'case-a');
        expect(new TestLabFixtureGenerator('repeatable-seed').xml({ tenantId: 'fixture', tipoDoc }, 'case-a')).toBe(seeded);
        expect(generator.xml({ tenantId: 'fixture', tipoDoc }, 'case-b')).not.toBe(seeded);
        const options = { tenantId: 'fixture', tipoDoc, documentNumber: 123456, valorCarga: 1000, emissionDate: '2026-09-28T12:00:00.000Z', tpAmbSefaz: 2 as const };
        const first = MockGeneratorService.generateMockXML(options);
        const now = jest.spyOn(Date, 'now').mockReturnValue(1);
        try { expect(MockGeneratorService.generateMockXML(options)).toBe(first); } finally { now.mockRestore(); }
      }
    });
  });
});
