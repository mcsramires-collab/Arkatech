import { TestLabStudioService } from './testLabStudio';

describe('TestLabStudioService', () => {
  test('expõe quais regras são realmente parametrizáveis', () => {
    const studio = TestLabStudioService.capabilities();
    const lmi = studio.capabilities.find((item) => item.key === 'policy.lmi');
    const access = studio.capabilities.find(
      (item) => item.key === 'access.insurer_policy_isolation'
    );
    const planned = studio.capabilities.find((item) => item.key === 'coverage.desconta_lmi');

    expect(lmi?.interactive).toBe(true);
    expect(access?.interactive).toBe(false);
    expect(planned?.interactive).toBe(false);
    expect(studio.interactive_count).toBeGreaterThan(0);
  });

  test('calcula matriz pairwise sem executar o motor', () => {
    const preview = TestLabStudioService.preview({
      strategy: 'PAIRWISE',
      dimensions: [
        { key: 'policy.status', values: ['ATIVA', 'INATIVA'] },
        { key: 'document.tipo', values: ['CTE', 'NFE'] },
        { key: 'document.valor_carga', values: [999, 1000, 1001] }
      ]
    });

    expect(preview.cartesian_estimate).toBe(12);
    expect(preview.cases).toBeGreaterThan(0);
    expect(preview.cases).toBeLessThanOrEqual(12);
  });

  test('executa um cenário interativo no motor real isolado', async () => {
    const run = await TestLabStudioService.execute({
      name: 'smoke studio',
      strategy: 'SINGLE',
      reference_date: '2026-09-29T12:00:00.000-03:00',
      dimensions: [
        { key: 'policy.status', values: ['ATIVA'] },
        { key: 'policy.lmi', values: [100000] },
        { key: 'document.tipo', values: ['CTE'] },
        { key: 'document.valor_carga', values: [1000] },
        { key: 'document.tp_amb', values: [2] },
        { key: 'document.funcao_cnpj_segurado', values: ['EMISSOR'] }
      ],
      fixture: {
        matching_mode: 'EXPLICIT'
      },
      expectation: {
        status: 'sucesso'
      }
    });

    expect(run.cases).toBe(1);
    expect(run.failed).toBe(0);
    expect(run.results[0]?.actual.status).toBe('sucesso');
  });

  test('marca FAIL quando esperado e obtido divergem', async () => {
    const run = await TestLabStudioService.execute({
      strategy: 'SINGLE',
      dimensions: [
        { key: 'policy.status', values: ['ATIVA'] },
        { key: 'document.tipo', values: ['CTE'] }
      ],
      expectation: {
        status: 'erro'
      }
    });

    expect(run.failed).toBe(1);
    expect(run.results[0]?.assertions[0]?.pass).toBe(false);
  });
});
