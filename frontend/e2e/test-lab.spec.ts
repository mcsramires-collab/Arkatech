import { expect, test } from '@playwright/test';

const catalog = {
  version: '1.0.0',
  environment_guard: 'TEST_ONLY',
  summary: { total_flags: 4, active: 2, invariants: 2, planned: 0, groups: 2, suites: 2 },
  extension_contract: {
    description: 'Nova flag entra no catálogo e aparece automaticamente.',
    required_fields: []
  },
  groups: [
    { key: 'policy', label: 'Apólice', description: 'Regras de apólice', order: 10 },
    { key: 'access', label: 'Segurança', description: 'Isolamento', order: 20 }
  ],
  flags: [
    {
      key: 'policy.status',
      group: 'policy',
      label: 'Status da apólice',
      description: 'Status operacional',
      value_type: 'ENUM',
      engine_status: 'ACTIVE',
      generation: 'ENUM_ALL',
      source: { kind: 'POLICY_FIELD', path: 'Policy.status' },
      tags: ['p0']
    },
    {
      key: 'access.insurer_policy_isolation',
      group: 'access',
      label: 'Isolamento entre seguradoras',
      description: 'Averbação segue a apólice da seguradora',
      value_type: 'INVARIANT',
      engine_status: 'INVARIANT',
      generation: 'INVARIANT_MATRIX',
      source: { kind: 'ACCESS', path: 'Policy.insurer_id' },
      tags: ['p0', 'security']
    }
  ],
  suites: [
    {
      key: 'p0-policy-engine',
      label: 'P0 — Motor de apólice',
      description: 'Motor principal',
      priority: 'P0',
      flag_keys: ['policy.status']
    },
    {
      key: 'p1-required-data',
      label: 'P1 — Dados obrigatórios',
      description: 'Regras complementares',
      priority: 'P1',
      flag_keys: []
    }
  ]
};

const completedRun = {
  id: 'LAB-E2E-001',
  mode: 'STANDARD',
  suite_keys: ['p0-policy-engine'],
  status: 'COMPLETED',
  environment: 'teste',
  total_planned: 1,
  total_executed: 1,
  passed: 1,
  failed: 0,
  gaps: 0,
  duration_ms: 12,
  created_at: '2026-09-28T20:00:00.000Z',
  completed_at: '2026-09-28T20:00:00.012Z',
  scenario_results: [
    {
      id: 'P0-POLICY-ACTIVE-SUCCESS',
      suite_key: 'p0-policy-engine',
      priority: 'P0',
      title: 'Apólice ativa dentro da vigência',
      description: 'Documento autorizado deve passar.',
      tags: ['policy'],
      covers_flag_keys: ['policy.status'],
      status: 'PASS',
      duration_ms: 5,
      assertions: [
        { key: 'status', label: 'Status do motor', expected: 'sucesso', actual: 'sucesso', pass: true }
      ]
    }
  ]
};

const studioCapabilities = {
  version: 'studio-v2',
  max_cases: 250,
  default_reference_date: '2026-09-29T12:00:00.000-03:00',
  interactive_count: 3,
  official_only_count: 1,
  capabilities: [
    {
      key: 'policy.status',
      label: 'Status da apólice',
      group: 'policy',
      description: 'Status operacional',
      engine_status: 'ACTIVE',
      value_type: 'ENUM',
      generation: 'ENUM_ALL',
      interactive: true,
      control: 'ENUM',
      options: [
        { value: 'ATIVA', label: 'Ativa' },
        { value: 'INATIVA', label: 'Inativa' }
      ],
      suggested_values: ['ATIVA', 'INATIVA']
    },
    {
      key: 'document.tipo',
      label: 'Tipo de documento',
      group: 'policy',
      description: 'Documento fiscal',
      engine_status: 'ACTIVE',
      value_type: 'ENUM',
      generation: 'ENUM_ALL',
      interactive: true,
      control: 'ENUM',
      options: [{ value: 'CTE', label: 'CT-e' }],
      suggested_values: ['CTE']
    },
    {
      key: 'document.valor_carga',
      label: 'Valor da carga',
      group: 'policy',
      description: 'Valor para o motor',
      engine_status: 'ACTIVE',
      value_type: 'NUMBER',
      generation: 'NUMERIC_BOUNDARIES',
      interactive: true,
      control: 'NUMBER',
      suggested_values: [999, 1000, 1001]
    },
    {
      key: 'access.insurer_policy_isolation',
      label: 'Isolamento entre seguradoras',
      group: 'access',
      description: 'Invariante oficial',
      engine_status: 'INVARIANT',
      value_type: 'INVARIANT',
      generation: 'INVARIANT_MATRIX',
      interactive: false,
      control: 'OFFICIAL_ONLY',
      reason: 'Coberta pela regressão oficial.'
    }
  ]
};

async function mockApi(page: import('@playwright/test').Page, runs: unknown[] = []) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.endsWith('/admin/test-lab/catalog')) {
      return json({ status: 'sucesso', catalog });
    }
    if (path.endsWith('/admin/test-lab/catalog-audit')) {
      return json({
        status: 'sucesso',
        audit: {
          detected_business_keys: ['regras:placa'],
          catalogued_keys: ['regras:placa'],
          uncatalogued_business_keys: [],
          catalogued_not_detected_in_backend: [],
          ok: true
        }
      });
    }
    if (path.endsWith('/admin/test-lab/studio/capabilities')) {
      return json({ status: 'sucesso', studio: studioCapabilities });
    }
    if (path.endsWith('/admin/test-lab/studio/preview') && method === 'POST') {
      return json({
        status: 'sucesso',
        preview: {
          name: 'Cenário de negócio',
          strategy: 'PAIRWISE',
          reference_date: '2026-09-29T12:00:00.000-03:00',
          cartesian_estimate: 1,
          cases: 1,
          preview: [{ 'policy.status': 'ATIVA', 'document.tipo': 'CTE' }],
          truncated_preview: false
        }
      });
    }
    if (path.endsWith('/admin/test-lab/studio/execute') && method === 'POST') {
      return json({
        status: 'sucesso',
        run: {
          id: 'STUDIO-E2E-001',
          name: 'Cenário de negócio',
          strategy: 'PAIRWISE',
          reference_date: '2026-09-29T12:00:00.000-03:00',
          cases: 1,
          passed: 0,
          failed: 0,
          unvalidated: 1,
          duration_ms: 8,
          results: [{
            index: 0,
            assignment: { 'policy.status': 'ATIVA', 'document.tipo': 'CTE' },
            status: 'UNVALIDATED',
            duration_ms: 8,
            expected: {},
            actual: {
              status: 'sucesso',
              codigo: 'SUC-2000',
              matched_policy: 'PRIMARY',
              mensagem: 'Averbação de teste realizada.'
            },
            assertions: []
          }]
        }
      });
    }
    if (path.endsWith('/admin/test-lab/plan') && method === 'POST') {
      return json({
        status: 'sucesso',
        plan: {
          mode: 'STANDARD',
          suite_keys: ['p0-policy-engine'],
          selected_flag_keys: ['policy.status'],
          total_scenarios: 1,
          p0: 1,
          p1: 0,
          estimated_cartesian_cases: 3,
          estimated_pairwise_cases: 3,
          scenarios: [
            {
              id: 'P0-POLICY-ACTIVE-SUCCESS',
              suite_key: 'p0-policy-engine',
              priority: 'P0',
              title: 'Apólice ativa dentro da vigência',
              description: 'Documento autorizado deve passar.',
              covers_flag_keys: ['policy.status']
            }
          ]
        }
      });
    }
    if (path.endsWith('/admin/test-lab/execute') && method === 'POST') {
      return json({ status: 'sucesso', run: completedRun });
    }
    if (path.endsWith('/admin/test-lab/runs')) {
      return json({ status: 'sucesso', runs });
    }

    if (path.endsWith('/admin/dashboard-stats')) {
      return json({ status: 'sucesso', stats: {} });
    }
    if (path.endsWith('/admin/tenants')) return json({ status: 'sucesso', tenants: [] });
    if (path.endsWith('/admin/policies')) return json({ status: 'sucesso', policies: [] });
    if (path.endsWith('/admin/policy-rules')) return json({ status: 'sucesso', rules: [] });
    if (path.endsWith('/admin/templates')) return json({ status: 'sucesso', templates: [] });
    if (path.endsWith('/admin/document-rules')) return json({ status: 'sucesso', rules: [] });
    if (path.endsWith('/admin/insurers')) return json({ status: 'sucesso', insurers: [] });
    if (path.endsWith('/admin/brokers')) return json({ status: 'sucesso', brokers: [] });
    if (path.endsWith('/admin/insurer-coverages')) return json({ status: 'sucesso', coverages: [] });

    return json({ status: 'sucesso' });
  });
}

test('Laboratório planeja e executa uma regressão P0 pela interface', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Laboratório de Testes' }).click();
  await expect(page.getByRole('heading', { name: 'Laboratório de Testes V2' })).toBeVisible();
  await expect(page.getByText('TEST ONLY')).toBeVisible();
  await page.getByRole('button', { name: 'Regressão Oficial' }).click();

  await page.getByRole('button', { name: 'Só P0' }).click();
  await page.getByRole('button', { name: 'Calcular cenários' }).click();

  await expect(page.getByText('Plano calculado')).toBeVisible();
  await expect(page.getByText('3 combinações')).toBeVisible();

  await page.getByRole('button', { name: 'Executar testes' }).click();

  await expect(page.getByText('Resultado — LAB-E2E-001')).toBeVisible();
  await expect(page.getByText('Apólice ativa dentro da vigência')).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'Apólice ativa dentro da vigência' }).getByText('PASS', { exact: true })).toBeVisible();
});

test('catálogo exibe governança e regra de isolamento', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Laboratório de Testes' }).click();
  await page.getByRole('button', { name: 'Regressão Oficial' }).click();

  await expect(page.getByText('Nenhuma chave')).toBeVisible();
  await expect(page.getByText('Isolamento entre seguradoras')).toBeVisible();
});


test('Laboratório V2 fica separado do teste de carga e abre jornada rápida', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Laboratório de Testes' }).click();
  await expect(page.getByRole('heading', { name: 'Laboratório de Testes V2' })).toBeVisible();
  await expect(page.getByText('Simulador de Carga Multi-Cliente')).not.toBeVisible();

  await page.getByRole('button', { name: 'Vigência & renovação' }).click();
  await expect(page.getByRole('heading', { name: 'Studio de Cenários' })).toBeVisible();

  await page.getByRole('button', { name: 'Teste de Carga' }).click();
  await expect(page.getByText('Simulador de Carga Multi-Cliente')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Laboratório de Testes V2' })).not.toBeVisible();
});

test('Studio V2 calcula matriz e executa um cenário interativo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Laboratório de Testes' }).click();
  await page.getByRole('button', { name: 'Studio de Cenários' }).click();

  await expect(page.getByRole('heading', { name: 'Studio de Cenários' })).toBeVisible();
  await page.getByRole('button', { name: 'Visualizar matriz' }).click();
  await expect(page.getByText('Primeiras combinações')).toBeVisible();

  await page.getByRole('button', { name: 'Executar matriz' }).click();
  await expect(page.getByText('Execution Center — Cenário de negócio')).toBeVisible();
  await expect(page.getByText('SUC-2000', { exact: true })).toBeVisible();
  await expect(page.getByText('Executado sem validação')).toBeVisible();
  await expect(page.getByText('0 PASS', {exact:true})).toBeVisible();
});

test('gate exige todos os cenários P0 do plano oficial', async ({ page }) => {
  await mockApi(page, [{...completedRun, scenario_results:[], total_executed:0}]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Laboratório de Testes' }).click();
  await expect(page.getByText('P0 não validado integralmente')).toBeVisible();
  await expect(page.getByText('P0 saudável')).toHaveCount(0);
});
test('gate aprova execução completa dos cenários planejados', async ({ page }) => {
  await mockApi(page, [completedRun]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Laboratório de Testes' }).click();
  await expect(page.getByText('P0 saudável')).toBeVisible();
});
