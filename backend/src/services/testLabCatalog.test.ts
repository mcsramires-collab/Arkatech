import { getTestLabCatalog } from './testLabCatalog';

describe('TestLabCatalog', () => {
  const catalog = getTestLabCatalog();

  test('mantém chaves de flags únicas', () => {
    const keys = catalog.flags.map((flag) => flag.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('toda flag pertence a um grupo existente', () => {
    const groups = new Set(catalog.groups.map((group) => group.key));
    for (const flag of catalog.flags) {
      expect(groups.has(flag.group)).toBe(true);
    }
  });

  test('toda suíte referencia somente flags existentes', () => {
    const flags = new Set(catalog.flags.map((flag) => flag.key));
    for (const suite of catalog.suites) {
      for (const key of suite.flag_keys) {
        expect(flags.has(key)).toBe(true);
      }
    }
  });

  test('invariantes de isolamento por seguradora são P0 e permanecem catalogadas', () => {
    const isolation = catalog.flags.find(
      (flag) => flag.key === 'access.insurer_policy_isolation'
    );
    expect(isolation).toBeDefined();
    expect(isolation?.engine_status).toBe('INVARIANT');
    expect(isolation?.tags).toContain('p0');

    const suite = catalog.suites.find((item) => item.key === 'p0-access-isolation');
    expect(suite?.priority).toBe('P0');
    expect(suite?.flag_keys).toContain('access.insurer_policy_isolation');
  });

  test('data de emissão é dimensão P0 ativa e pertence ao motor de apólice', () => {
    const emission = catalog.flags.find((item) => item.key === 'document.data_emissao');
    expect(emission).toBeDefined();
    expect(emission?.engine_status).toBe('ACTIVE');
    expect(emission?.generation).toBe('DATE_BOUNDARIES');

    const suite = catalog.suites.find((item) => item.key === 'p0-policy-engine');
    expect(suite?.flag_keys).toContain('document.data_emissao');
  });

  test('vigência inicial é regra P0 ativa do motor', () => {
    const flag = catalog.flags.find((item) => item.key === 'policy.vigencia_inicio');
    expect(flag).toBeDefined();
    expect(flag?.engine_status).toBe('ACTIVE');
    expect(flag?.generation).toBe('DATE_BOUNDARIES');

    const suite = catalog.suites.find((item) => item.key === 'p0-policy-engine');
    expect(suite?.flag_keys).toContain('policy.vigencia_inicio');
  });

  test('gaps conhecidos não são apresentados como motor validado', () => {
    const descontaLmi = catalog.flags.find((flag) => flag.key === 'coverage.desconta_lmi');
    expect(descontaLmi?.engine_status).toBe('PLANNED');

    const esporadica = catalog.flags.find(
      (flag) => flag.key === 'regras:averbacao-esporadica-on'
    );
    expect(esporadica?.engine_status).toBe('PLANNED');
  });
});
