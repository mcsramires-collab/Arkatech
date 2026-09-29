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

async function mockApi(page: import('@playwright/test').Page) {
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
      return json({ status: 'sucesso', runs: [] });
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
  await expect(page.getByRole('heading', { name: 'Laboratório de Testes' })).toBeVisible();
  await expect(page.getByText('TEST ONLY')).toBeVisible();

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

  await expect(page.getByText('Nenhuma chave')).toBeVisible();
  await expect(page.getByText('Isolamento entre seguradoras')).toBeVisible();
});
