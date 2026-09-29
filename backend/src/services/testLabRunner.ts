import { now, withClock } from './clock';
import { v4 as uuidv4 } from 'uuid';
import {
  Averbacao,
  Connector,
  Policy,
  TestLabAssertionResult,
  TestLabMode,
  TestLabPriority,
  TestLabRun,
  TestLabScenarioResult,
  TipoDocumento
} from '../types';
import { dbStore } from './dbStore';
import { AverbacaoService, AverbacaoResponseDTO } from './averbacao';
import { CancelamentoService } from './cancelamento';
import { ConnectorFiscalService } from './connectorFiscalService';
import { DocumentIngestionService } from './ingestion/documentIngestion';
import { InsurerVisibilityService } from './insurerVisibilityService';
import { MockGeneratorService, MockGenerationOptions } from './mockGenerator';
import { RuleEngineService } from './ruleEngine';
import { MockSefazService } from '../mockSefaz/mockSefazService';
import { getTestLabCatalog } from './testLabCatalog';
import { TestLabCatalogAuditService } from './testLabCatalogAudit';
import { TestLabScenarioGenerator, ScenarioDimension } from './testLabScenarioGenerator';
import { TestLabFixtureGenerator } from './testLabFixtureGenerator';

export interface TestLabPlanRequest {
  mode?: TestLabMode;
  suite_keys?: string[];
  selected_flag_keys?: string[];
  only_scenario_ids?: string[];
  rerun_of?: string;
}

export interface TestLabPlan {
  mode: TestLabMode;
  suite_keys: string[];
  selected_flag_keys: string[];
  total_scenarios: number;
  p0: number;
  p1: number;
  estimated_cartesian_cases: number;
  estimated_pairwise_cases: number;
  scenarios: Array<{
    id: string;
    suite_key: string;
    priority: TestLabPriority;
    title: string;
    description: string;
    covers_flag_keys: string[];
    gap_reason?: string;
  }>;
}

interface ScenarioExecution {
  assertions: TestLabAssertionResult[];
  evidence?: Record<string, unknown>;
}

interface ScenarioDefinition {
  id: string;
  suite_key: string;
  priority: TestLabPriority;
  title: string;
  description: string;
  tags: string[];
  covers_flag_keys: string[];
  quick?: boolean;
  gap_reason?: string;
  execute?: () => Promise<ScenarioExecution> | ScenarioExecution;
}

interface LabContext {
  tenantId: string;
  insurerAId: string;
  insurerBId: string;
  brokerId: string;
  policyId: string;
  keepAlivePolicyId: string;
}

function assertion(
  key: string,
  label: string,
  expected: unknown,
  actual: unknown,
  detail?: string
): TestLabAssertionResult {
  const pass =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(expected - actual) < 0.000001
      : JSON.stringify(expected) === JSON.stringify(actual);
  return { key, label, expected, actual, pass, detail };
}

function includesAssertion(
  key: string,
  label: string,
  expectedItem: string,
  actual: unknown
): TestLabAssertionResult {
  const list = Array.isArray(actual) ? actual.map(String) : [];
  return {
    key,
    label,
    expected: expectedItem,
    actual,
    pass: list.includes(expectedItem)
  };
}

function isoFromNow(deltaMs: number): string {
  return new Date(now() + deltaMs).toISOString();
}

function brDateFromNow(deltaDays: number): string {
  const date = new Date(now() + deltaDays * 24 * 60 * 60 * 1000);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return dd + '/' + mm + '/' + date.getFullYear();
}

function setupBase(policyOverrides: Partial<Policy> = {}): LabContext {
  const timestamp = new Date(now()).toISOString();
  const tenantId = 'lab-tenant-shared';
  const insurerAId = 'lab-insurer-a';
  const insurerBId = 'lab-insurer-b';
  const brokerId = 'lab-broker';
  const policyId = 'lab-policy-a-rctrc';
  const keepAlivePolicyId = 'lab-policy-a-rcv';

  dbStore.tenants = [
    {
      id: tenantId,
      cnpj: '12345678000190',
      razao_social: 'TRANSPORTADORA LAB TESTE',
      nome_fantasia: 'LAB TESTE',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'lab-client',
      client_secret_hash: 'lab-hash',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: timestamp
    }
  ];

  dbStore.insurers = [
    {
      id: insurerAId,
      cnpj: '11111111000191',
      nome: 'SEGURADORA A LAB',
      razao_social: 'SEGURADORA A LAB',
      nome_fantasia: 'SEG A',
      created_at: timestamp
    },
    {
      id: insurerBId,
      cnpj: '22222222000192',
      nome: 'SEGURADORA B LAB',
      razao_social: 'SEGURADORA B LAB',
      nome_fantasia: 'SEG B',
      created_at: timestamp
    }
  ];

  dbStore.brokers = [
    {
      id: brokerId,
      cnpj: '33333333000193',
      nome: 'CORRETORA LAB',
      razao_social: 'CORRETORA LAB',
      partner_type: 'CORRETORA',
      created_at: timestamp
    }
  ];

  const mainPolicy: Policy = {
    id: policyId,
    numero_apolice: 'LAB-A-RCTRC-001',
    ramo: 'RCTRC',
    tenant_id: tenantId,
    insurer_id: insurerAId,
    broker_id: brokerId,
    status: 'ATIVA',
    permitir_inativo_vencido: false,
    vigencia_inicio: isoFromNow(-30 * 24 * 60 * 60 * 1000),
    vigencia_fim: isoFromNow(365 * 24 * 60 * 60 * 1000),
    aceita_averbacao_como_destinatario: false,
    ...policyOverrides
  };

  const keepAlivePolicy: Policy = {
    id: keepAlivePolicyId,
    numero_apolice: 'LAB-A-RCV-KEEPALIVE',
    ramo: 'RCV',
    tenant_id: tenantId,
    insurer_id: insurerAId,
    broker_id: brokerId,
    status: 'ATIVA',
    permitir_inativo_vencido: false,
    vigencia_inicio: isoFromNow(-30 * 24 * 60 * 60 * 1000),
    vigencia_fim: isoFromNow(365 * 24 * 60 * 60 * 1000),
    aceita_averbacao_como_destinatario: false
  };

  dbStore.policies = [mainPolicy, keepAlivePolicy];
  dbStore.policyRules = [];
  dbStore.documentRules = [];
  dbStore.averbacoes = [];
  dbStore.rawXmlStore = [];
  dbStore.fiscalDocuments = [];
  dbStore.connectors = [];
  dbStore.fiscalSyncStates = [];
  dbStore.fiscalEvents = [];
  dbStore.recoverySessions = [];
  dbStore.insurerCoverages = [];
  dbStore.policyTitularityRules = [];
  dbStore.policyBypassRules = [];
  dbStore.policyBusinessSettings = [];
  dbStore.policySublimites = [];
  dbStore.policyCoverageValues = [];
  dbStore.liberationCodes = [];
  dbStore.operationalNotifications = [];
  dbStore.whatsappMessages = [];

  return {
    tenantId,
    insurerAId,
    insurerBId,
    brokerId,
    policyId,
    keepAlivePolicyId
  };
}

function mainPolicy(ctx: LabContext): Policy {
  const policy = dbStore.policies.find((item) => item.id === ctx.policyId);
  if (!policy) throw new Error('LAB_MAIN_POLICY_MISSING');
  return policy;
}

function setBusinessConfig(ctx: LabContext, config: Record<string, unknown>): void {
  dbStore.policyBusinessSettings = [
    {
      id: 'lab-settings-' + ctx.policyId,
      policy_id: ctx.policyId,
      config,
      updated_at: new Date().toISOString()
    }
  ];
}

function makeXml(
  ctx: LabContext,
  overrides: Partial<MockGenerationOptions> = {}
): string {
  return new TestLabFixtureGenerator('arckatech-standard-v1', new Date().toISOString()).xml({
    tenantId: ctx.tenantId,
    tipoDoc: 'CTE',
    policyId: ctx.policyId,
    documentNumber: 570001,
    valorCarga: 500,
    tpAmbSefaz: 2,
    emissionDate: new Date().toISOString(),
    ...overrides
  });
}

function processAverbacao(
  ctx: LabContext,
  fixtureOverrides: Partial<MockGenerationOptions> = {},
  dtoOverrides: {
    supplemented_vars?: Record<string, unknown>;
    codigo_liberacao?: string;
  } = {}
): AverbacaoResponseDTO {
  return AverbacaoService.process({
    tenant_id: ctx.tenantId,
    ramo: 'RCTRC',
    policy_id: ctx.policyId,
    xml_content: makeXml(ctx, fixtureOverrides),
    supplemented_vars: dtoOverrides.supplemented_vars,
    codigo_liberacao: dtoOverrides.codigo_liberacao
  });
}

function cancellationXml(chave: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<procEventoCTe>',
    '  <eventoCTe>',
    '    <infEvento>',
    '      <tpEvento>110111</tpEvento>',
    '      <chCTe>' + chave + '</chCTe>',
    '      <dhEvento>' + new Date().toISOString() + '</dhEvento>',
    '      <detEvento>',
    '        <evCancCTe>',
    '          <xJust>Cancelamento controlado do Laboratorio Arckatech</xJust>',
    '        </evCancCTe>',
    '      </detEvento>',
    '    </infEvento>',
    '  </eventoCTe>',
    '  <retEventoCTe>',
    '    <infEvento><nProt>LAB-CANCEL-001</nProt></infEvento>',
    '  </retEventoCTe>',
    '</procEventoCTe>'
  ].join('\n');
}

function successfulAverbacaoFromResponse(response: AverbacaoResponseDTO): Averbacao {
  const record = response.averbacao_id
    ? dbStore.averbacoes.find((item) => item.id === response.averbacao_id)
    : undefined;
  if (!record) throw new Error('LAB_AVERBACAO_RESULT_MISSING');
  return record;
}

function generatedLimitMatrixScenarios(mode: TestLabMode): ScenarioDefinition[] {
  if (mode === 'QUICK') return [];

  const dimensions: ScenarioDimension[] = [
    {
      key: 'strategy',
      values: ['aceitar-sem-trava', 'truncar', 'exigir-codigo', 'sem-codigo']
    },
    {
      key: 'relation',
      values: ['below', 'equal', 'above']
    },
    {
      key: 'no_code_mode',
      values: ['fila-sempre', 'teto']
    },
    {
      key: 'above_action',
      values: ['fila', 'recusar']
    }
  ];

  const assignments =
    mode === 'EXHAUSTIVE'
      ? TestLabScenarioGenerator.cartesian(dimensions, 500)
      : TestLabScenarioGenerator.pairwise(dimensions, 500);

  return assignments.map((assignment, index) => {
    const strategy = String(assignment.strategy);
    const relation = String(assignment.relation);
    const noCodeMode = String(assignment.no_code_mode);
    const aboveAction = String(assignment.above_action);
    const value = relation === 'below' ? 999 : relation === 'equal' ? 1000 : 1100;

    return {
      id:
        'P0-LIMIT-MATRIX-' +
        String(index + 1).padStart(3, '0') +
        '-' +
        [strategy, relation, noCodeMode, aboveAction]
          .join('-')
          .replace(/[^A-Za-z0-9-]+/g, ''),
      suite_key: 'p0-limits',
      priority: 'P0' as const,
      title: 'Matriz automática de limite #' + (index + 1),
      description:
        'Cenário gerado automaticamente (' +
        (mode === 'EXHAUSTIVE' ? 'cartesiano' : 'pairwise') +
        ') para combinar estratégia, fronteira e tratamento sem código.',
      tags: ['generated', 'limits', mode.toLowerCase()],
      covers_flag_keys: [
        'policy.lmi',
        'document.valor_carga',
        'regras:estrategia-lmg',
        'regras:sem-codigo-modo',
        'regras:teto-valor',
        'regras:teto-acima-acao'
      ],
      execute: () => {
        const ctx = setupBase({ lmi: 1000 });
        setBusinessConfig(ctx, {
          'regras:estrategia-lmg': strategy,
          'regras:sem-codigo-modo': noCodeMode,
          'regras:teto-valor': 1050,
          'regras:teto-acima-acao': aboveAction
        });

        const result = processAverbacao(ctx, {
          valorCarga: value,
          documentNumber: 579000 + index
        });

        let expectedStatus: AverbacaoResponseDTO['status'] = 'sucesso';
        let expectedValue = value;

        if (relation === 'above') {
          if (strategy === 'truncar') {
            expectedStatus = 'sucesso';
            expectedValue = 1000;
          } else if (strategy === 'aceitar-sem-trava') {
            expectedStatus = 'sucesso';
          } else if (strategy === 'exigir-codigo') {
            expectedStatus = 'erro';
          } else if (noCodeMode === 'fila-sempre') {
            expectedStatus = 'pendente';
          } else {
            expectedStatus = aboveAction === 'recusar' ? 'erro' : 'pendente';
          }
        }

        const assertions = [
          assertion('status', 'Status calculado pela matriz', expectedStatus, result.status)
        ];

        if (expectedStatus === 'sucesso') {
          assertions.push(
            assertion('value', 'Valor considerado', expectedValue, result.valor_considerado_averbacao)
          );
        } else {
          assertions.push(assertion('code', 'Código de limite', 'ERR-4010', result.codigo));
        }

        return {
          assertions,
          evidence: {
            assignment,
            generator: mode === 'EXHAUSTIVE' ? 'CARTESIAN' : 'PAIRWISE'
          }
        };
      }
    };
  });
}

function generatedCatalogScenarios(mode: TestLabMode): ScenarioDefinition[] {
  if (mode === 'QUICK') return [];
  const catalog = getTestLabCatalog();
  const values = (key: string) => TestLabScenarioGenerator.valuesForFlag(catalog.flags.find(f => f.key === key)!);
  const scenarios: ScenarioDefinition[] = [];
  for (const status of values('policy.status')) {
    for (const bypass of values('policy.permitir_inativo_vencido')) {
      scenarios.push({
        id: `GEN-POLICY-${status}-${bypass}`, suite_key: 'p0-policy-engine', priority: 'P0',
        title: `Status ${status}, permitir inativo/vencido ${bypass}`, description: 'Matriz gerada dos valores do catálogo e executada no motor real.',
        tags: ['generated', 'ENUM_ALL', 'BOOLEAN_BOTH'], covers_flag_keys: ['policy.status','policy.permitir_inativo_vencido'],
        execute: () => {
          const ctx = setupBase({ status: status as Policy['status'], permitir_inativo_vencido: Boolean(bypass) });
          const response = processAverbacao(ctx);
          return { assertions: [assertion('status', 'Resultado do motor', status === 'ATIVA' ? 'sucesso' : bypass ? 'aviso' : 'erro', response.status)], evidence: { status, bypass, response } };
        }
      });
    }
  }
  const limitFlag = catalog.flags.find(f => f.key === 'policy.lmi')!;
  const boundaries = values('policy.lmi') as number[];
  const limit = boundaries[1]!;
  for (const value of boundaries) scenarios.push({
    id: `GEN-LMI-${value}`, suite_key: 'p0-limits', priority: 'P0', title: `LMI: carga ${value}, limite ${limit}`,
    description: 'Limite e fronteiras definidos pelo catálogo.', tags: ['generated', limitFlag.generation], covers_flag_keys: ['policy.lmi', 'document.valor_carga'],
    execute: () => {
      const ctx = setupBase({ lmi: limit }); const response = processAverbacao(ctx, { valorCarga: value });
      return { assertions: [assertion('status', 'Limite aplicado', value > limit ? 'erro' : 'sucesso', response.status)], evidence: { value, limit, response } };
    }
  });
  for (const offset of [-1, 0, 1]) scenarios.push({
    id: `GEN-DATE-END-${offset}`, suite_key: 'p0-policy-engine', priority: 'P0',
    title: `Fim da vigência: fronteira ${offset} ms`, description: 'Compara antes, exatamente no limite e após a vigência com relógio isolado.',
    tags: ['generated', 'DATE_BOUNDARIES'], covers_flag_keys: ['policy.vigencia_fim'],
    execute: () => withClock(Date.parse('2026-09-28T12:00:00.000Z'), () => {
      const ctx = setupBase({ vigencia_fim: new Date(now() + offset).toISOString() });
      const response = processAverbacao(ctx, { emissionDate: new Date(now()).toISOString() });
      return { assertions: [assertion('status', 'Fronteira de vigência', offset < 0 ? 'pendente' : 'sucesso', response.status)], evidence: { offset, reference_date: new Date(now()).toISOString(), response } };
    })
  });
  const matrix = TestLabScenarioGenerator.invariantMatrix([
    { key: 'actor', values: ['a','b'] }, { key: 'owner', values: ['a','b'] }, { key: 'sameBranch', values: [false,true] }
  ]);
  for (const row of matrix) scenarios.push({
    id: `GEN-ACCESS-${row.actor}-${row.owner}-${row.sameBranch}`, suite_key: 'p0-access-isolation', priority: 'P0',
    title: `Acesso ${row.actor} → ${row.owner}, mesmo ramo ${row.sameBranch}`, description: 'Matriz completa de propriedade, IDOR e agregado para o mesmo segurado.',
    tags: ['generated', 'INVARIANT_MATRIX'], covers_flag_keys: ['access.insurer_policy_isolation','access.direct_object_reference','access.aggregate_isolation','access.same_tenant_same_branch_two_insurers'],
    execute: () => {
      const ctx = setupBase(); const original = mainPolicy(ctx);
      const other = { ...original, id: 'matrix-policy-b', insurer_id: ctx.insurerBId, ramo: row.sameBranch ? original.ramo : 'RCDC' } as Policy;
      dbStore.policies = [original, other];
      const target = row.owner === 'a' ? original : other;
      const actor = row.actor === 'a' ? ctx.insurerAId : ctx.insurerBId;
      dbStore.averbacoes = [{ id: 'matrix-avb', policy_id: target.id, tenant_id: ctx.tenantId, valor_carga: 123, valor_considerado_averbacao: 123, status: 'SUCESSO' }] as any;
      const allowed = row.actor === row.owner;
      return { assertions: [
        assertion('policy', 'Acesso à apólice', allowed, InsurerVisibilityService.canAccessPolicy(actor, target.id)),
        assertion('idor', 'Acesso direto à averbação', allowed, InsurerVisibilityService.canAccessAverbacao(actor, 'matrix-avb')),
        assertion('list', 'Lista por segurado', allowed ? 1 : 0, InsurerVisibilityService.averbacoes(actor, { tenant_id: ctx.tenantId }).length),
        assertion('aggregate', 'Valor agregado', allowed ? 123 : 0, InsurerVisibilityService.aggregate(actor).valor_total_averbado)
      ], evidence: row };
    }
  });
  return scenarios;
}

function defineScenarios(mode: TestLabMode = 'STANDARD'): ScenarioDefinition[] {
  const scenarios: ScenarioDefinition[] = [];
  scenarios.push(...generatedLimitMatrixScenarios(mode), ...generatedCatalogScenarios(mode));

  scenarios.push({
    id: 'P0-POLICY-ACTIVE-SUCCESS',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Apólice ativa dentro da vigência',
    description: 'Documento autorizado e titular deve resultar em averbação de teste com sucesso.',
    tags: ['policy', 'smoke'],
    covers_flag_keys: ['policy.status', 'policy.vigencia_fim'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      const result = processAverbacao(ctx);
      return {
        assertions: [
          assertion('status', 'Status do motor', 'sucesso', result.status),
          assertion('codigo', 'Código de sucesso', 'SUC-2000', result.codigo),
          assertion(
            'numero_teste',
            'Número de homologação inicia com TESTE-',
            true,
            Boolean(result.numero_averbacao && result.numero_averbacao.startsWith('TESTE-'))
          )
        ],
        evidence: { averbacao_id: result.averbacao_id }
      };
    }
  });

  scenarios.push({
    id: 'P0-POLICY-INACTIVE-BLOCK',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Apólice inativa sem bypass',
    description: 'Apólice inativa deve ser bloqueada mesmo quando o segurado possui outra apólice ativa.',
    tags: ['policy'],
    covers_flag_keys: ['policy.status', 'policy.permitir_inativo_vencido'],
    execute: () => {
      const ctx = setupBase({ status: 'INATIVA', permitir_inativo_vencido: false });
      const result = processAverbacao(ctx);
      return {
        assertions: [
          assertion('status', 'Status', 'erro', result.status),
          assertion('codigo', 'Código de apólice inativa', 'ERR-4003', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-POLICY-EXPIRED-PENDING',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Vigência encerrada vira pendência',
    description: 'Fim de vigência passado deve gerar ERR-4011/PENDENTE_APROVACAO.',
    tags: ['policy', 'deadline'],
    covers_flag_keys: ['policy.vigencia_fim', 'policy.permitir_inativo_vencido'],
    execute: () => {
      const ctx = setupBase({
        vigencia_fim: isoFromNow(-24 * 60 * 60 * 1000),
        permitir_inativo_vencido: false
      });
      const result = processAverbacao(ctx);
      const record = result.averbacao_id
        ? dbStore.averbacoes.find((item) => item.id === result.averbacao_id)
        : undefined;
      return {
        assertions: [
          assertion('status', 'Status', 'pendente', result.status),
          assertion('codigo', 'Código de vigência encerrada', 'ERR-4011', result.codigo),
          assertion('record_status', 'Persistência como pendência', 'PENDENTE_APROVACAO', record?.status)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-POLICY-EXPIRED-BYPASS',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Bypass de apólice vencida',
    description: 'Flag permitir_inativo_vencido deve permitir processamento com aviso.',
    tags: ['policy', 'bypass'],
    covers_flag_keys: ['policy.permitir_inativo_vencido', 'policy.vigencia_fim'],
    execute: () => {
      const ctx = setupBase({
        vigencia_fim: isoFromNow(-24 * 60 * 60 * 1000),
        permitir_inativo_vencido: true
      });
      const result = processAverbacao(ctx);
      return {
        assertions: [
          assertion('status', 'Status com bypass', 'aviso', result.status),
          assertion('codigo', 'Código de sucesso com aviso', 'SUC-2001', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-POLICY-SUSPENDED',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Apólice suspensa',
    description: 'Suspensão vigente deve gerar pendência específica.',
    tags: ['policy', 'suspension'],
    covers_flag_keys: ['policy.suspensao'],
    execute: () => {
      const ctx = setupBase({
        suspensa_desde: isoFromNow(-60 * 60 * 1000),
        suspensa_ate: isoFromNow(60 * 60 * 1000)
      });
      const result = processAverbacao(ctx);
      return {
        assertions: [
          assertion('status', 'Status', 'pendente', result.status),
          assertion('codigo', 'Código de suspensão', 'ERR-4017', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-TITULARITY-DESTINATION-DENIED',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Destinatário não autorizado',
    description: 'CNPJ do segurado apenas como destinatário deve ser recusado quando a apólice não autoriza.',
    tags: ['titularity'],
    covers_flag_keys: ['policy.aceita_averbacao_como_destinatario', 'document.funcao_cnpj_segurado'],
    execute: () => {
      const ctx = setupBase({ aceita_averbacao_como_destinatario: false });
      const result = processAverbacao(ctx, { funcaoTenant: 'DESTINATARIO' });
      return {
        assertions: [
          assertion('status', 'Status', 'erro', result.status),
          assertion('codigo', 'Código de titularidade', 'ERR-4008', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-TITULARITY-DESTINATION-ALLOWED',
    suite_key: 'p0-policy-engine',
    priority: 'P0',
    title: 'Destinatário autorizado',
    description: 'Flag de destinatário deve permitir a averbação quando o CNPJ aparece nesta função.',
    tags: ['titularity'],
    covers_flag_keys: ['policy.aceita_averbacao_como_destinatario', 'document.funcao_cnpj_segurado'],
    quick: true,
    execute: () => {
      const ctx = setupBase({ aceita_averbacao_como_destinatario: true });
      const result = processAverbacao(ctx, { funcaoTenant: 'DESTINATARIO' });
      return {
        assertions: [
          assertion('status', 'Status', 'sucesso', result.status),
          assertion('codigo', 'Código', 'SUC-2000', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-LMI-BOUNDARIES',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Fronteiras de LMI',
    description: 'Abaixo e igual ao LMI passam; acima do LMI sem liberação é bloqueado.',
    tags: ['lmi', 'boundary'],
    covers_flag_keys: ['policy.lmi', 'document.valor_carga'],
    quick: true,
    execute: () => {
      const belowCtx = setupBase({ lmi: 1000 });
      const below = processAverbacao(belowCtx, { valorCarga: 999, documentNumber: 570101 });

      const equalCtx = setupBase({ lmi: 1000 });
      const equal = processAverbacao(equalCtx, { valorCarga: 1000, documentNumber: 570102 });

      const aboveCtx = setupBase({ lmi: 1000 });
      const above = processAverbacao(aboveCtx, { valorCarga: 1001, documentNumber: 570103 });

      return {
        assertions: [
          assertion('below', 'Abaixo do LMI', 'sucesso', below.status),
          assertion('equal', 'Igual ao LMI', 'sucesso', equal.status),
          assertion('above_status', 'Acima do LMI', 'erro', above.status),
          assertion('above_code', 'Código de excesso', 'ERR-4010', above.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-LIMIT-STRATEGY-TRUNCATE',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Estratégia truncar',
    description: 'Valor acima do LMI deve ser truncado para o limite quando configurado.',
    tags: ['lmi', 'strategy'],
    covers_flag_keys: ['regras:estrategia-lmg', 'policy.lmi'],
    execute: () => {
      const ctx = setupBase({ lmi: 1000 });
      setBusinessConfig(ctx, { 'regras:estrategia-lmg': 'truncar' });
      const result = processAverbacao(ctx, { valorCarga: 1200 });
      return {
        assertions: [
          assertion('status', 'Status', 'sucesso', result.status),
          assertion('value', 'Valor considerado truncado', 1000, result.valor_considerado_averbacao)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-LIMIT-STRATEGY-ACCEPT',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Estratégia aceitar sem trava',
    description: 'Excedente deve manter o valor original quando a estratégia permite.',
    tags: ['lmi', 'strategy'],
    covers_flag_keys: ['regras:estrategia-lmg', 'policy.lmi'],
    execute: () => {
      const ctx = setupBase({ lmi: 1000 });
      setBusinessConfig(ctx, { 'regras:estrategia-lmg': 'aceitar-sem-trava' });
      const result = processAverbacao(ctx, { valorCarga: 1200 });
      return {
        assertions: [
          assertion('status', 'Status', 'sucesso', result.status),
          assertion('value', 'Valor integral', 1200, result.valor_considerado_averbacao)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-LIMIT-NO-CODE-QUEUE',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Sem código envia para fila',
    description: 'Estratégia sem-codigo/fila-sempre deve produzir pendência.',
    tags: ['lmi', 'pending'],
    covers_flag_keys: ['regras:estrategia-lmg', 'regras:sem-codigo-modo'],
    execute: () => {
      const ctx = setupBase({ lmi: 1000 });
      setBusinessConfig(ctx, {
        'regras:estrategia-lmg': 'sem-codigo',
        'regras:sem-codigo-modo': 'fila-sempre'
      });
      const result = processAverbacao(ctx, { valorCarga: 1200 });
      return {
        assertions: [
          assertion('status', 'Status', 'pendente', result.status),
          assertion('codigo', 'Código', 'ERR-4010', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-LIMIT-THRESHOLD-ACTIONS',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Teto e ação acima do teto',
    description: 'Valida aprovação até o teto e recusa acima dele.',
    tags: ['lmi', 'threshold'],
    covers_flag_keys: ['regras:teto-valor', 'regras:teto-acima-acao', 'regras:sem-codigo-modo'],
    execute: () => {
      const approvedCtx = setupBase({ lmi: 1000 });
      setBusinessConfig(approvedCtx, {
        'regras:estrategia-lmg': 'sem-codigo',
        'regras:sem-codigo-modo': 'teto',
        'regras:teto-valor': 1200,
        'regras:teto-acima-acao': 'recusar'
      });
      const approved = processAverbacao(approvedCtx, { valorCarga: 1100, documentNumber: 570201 });

      const deniedCtx = setupBase({ lmi: 1000 });
      setBusinessConfig(deniedCtx, {
        'regras:estrategia-lmg': 'sem-codigo',
        'regras:sem-codigo-modo': 'teto',
        'regras:teto-valor': 1050,
        'regras:teto-acima-acao': 'recusar'
      });
      const denied = processAverbacao(deniedCtx, { valorCarga: 1100, documentNumber: 570202 });

      return {
        assertions: [
          assertion('under_threshold', 'Até o teto', 'sucesso', approved.status),
          assertion('above_threshold', 'Acima do teto', 'erro', denied.status),
          assertion('above_code', 'Código acima do teto', 'ERR-4010', denied.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-LIMIT-GENERIC-QUEUE',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Fila genérica de recusas',
    description: 'Recusa de titularidade deve virar pendência quando a fila genérica está habilitada.',
    tags: ['pending', 'rules'],
    covers_flag_keys: ['regras:fila-aprovacao-recusas'],
    execute: () => {
      const ctx = setupBase({ aceita_averbacao_como_destinatario: false });
      setBusinessConfig(ctx, { 'regras:fila-aprovacao-recusas': true });
      const result = processAverbacao(ctx, { funcaoTenant: 'DESTINATARIO' });
      return {
        assertions: [
          assertion('status', 'Status', 'pendente', result.status),
          assertion('codigo', 'Motivo preservado', 'ERR-4008', result.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-SUBLIMIT-PRECEDENCE',
    suite_key: 'p0-limits',
    priority: 'P0',
    title: 'Precedência dos sublimites',
    description: 'Tomador+mercadoria deve prevalecer sobre tomador e mercadoria isolados.',
    tags: ['sublimit', 'precedence'],
    covers_flag_keys: ['sublimit.tipo_condicao', 'sublimit.valor', 'regras:estrategia-lmg'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      setBusinessConfig(ctx, { 'regras:estrategia-lmg': 'truncar' });
      dbStore.policySublimites = [
        {
          id: 'lab-sub-merc',
          policy_id: ctx.policyId,
          tipo_condicao: 'mercadoria',
          tag: 'Carga Geral Embalada',
          valor: 'R$ 900,00',
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-sub-tomador',
          policy_id: ctx.policyId,
          tipo_condicao: 'tomador',
          cnpj_tomador: '98765432000188',
          valor: 'R$ 800,00',
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-sub-combo',
          policy_id: ctx.policyId,
          tipo_condicao: 'tomador_mercadoria',
          cnpj_tomador: '98765432000188',
          tag: 'Carga Geral Embalada',
          valor: 'R$ 700,00',
          created_at: new Date().toISOString()
        }
      ];
      const result = processAverbacao(ctx, { valorCarga: 750 });
      return {
        assertions: [
          assertion('status', 'Status', 'sucesso', result.status),
          assertion('precedence', 'Valor do sublimite mais específico', 700, result.valor_considerado_averbacao)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-DYNAMIC-RULES',
    suite_key: 'p1-required-data',
    priority: 'P1',
    title: 'Variáveis dinâmicas de apólice e documento',
    description: 'Prova o mecanismo genérico que permite criar novas variáveis obrigatórias sem alterar o motor.',
    tags: ['dynamic-rule', 'future-proof'],
    covers_flag_keys: [
      'policy_rule.obrigatoria',
      'policy_rule.tipo_doc',
      'document_rule.obrigatoria',
      'document_rule.tipo_documento'
    ],
    execute: () => {
      const policyCtx = setupBase();
      dbStore.policyRules = [
        {
          id: 'lab-policy-rule',
          policy_id: policyCtx.policyId,
          tipo_doc: 'CTE',
          tag_path: 'VARIAVEL_NOVA',
          nome_variavel: 'VARIAVEL_NOVA',
          obrigatoria: true,
          exemplo_preenchimento: 'EXEMPLO',
          created_at: new Date().toISOString()
        }
      ] as any;

      const policyMissing = processAverbacao(policyCtx, { documentNumber: 577001 });
      const policySupplied = processAverbacao(
        policyCtx,
        { documentNumber: 577002 },
        { supplemented_vars: { VARIAVEL_NOVA: 'VALOR_OK' } }
      );

      const wrongTypeCtx = setupBase();
      dbStore.policyRules = [
        {
          id: 'lab-policy-rule-nfe',
          policy_id: wrongTypeCtx.policyId,
          tipo_doc: 'NFE',
          tag_path: 'SOMENTE_NFE',
          nome_variavel: 'SOMENTE_NFE',
          obrigatoria: true,
          created_at: new Date().toISOString()
        }
      ] as any;
      const wrongType = processAverbacao(wrongTypeCtx, { documentNumber: 577003 });

      const documentCtx = setupBase();
      dbStore.documentRules = [
        {
          id: 'lab-document-rule',
          tipo_documento: 'CTE',
          tag_path: 'REGRA_GLOBAL',
          nome_variavel: 'REGRA_GLOBAL',
          obrigatoria: true,
          origem: 'CUSTOM',
          created_at: new Date().toISOString()
        }
      ] as any;
      const documentMissing = processAverbacao(documentCtx, { documentNumber: 577004 });
      const documentSupplied = processAverbacao(
        documentCtx,
        { documentNumber: 577005 },
        { supplemented_vars: { REGRA_GLOBAL: 'PREENCHIDO' } }
      );

      return {
        assertions: [
          assertion('policy_missing_status', 'PolicyRule ausente gera erro', 'erro', policyMissing.status),
          assertion('policy_missing_code', 'PolicyRule usa recuperação genérica', 'ERR-4004', policyMissing.codigo),
          includesAssertion('policy_missing_var', 'Nova variável aparece como faltante', 'VARIAVEL_NOVA', policyMissing.variaveis_faltantes),
          assertion('policy_supplied', 'Variável suplementada libera averbação', 'sucesso', policySupplied.status),
          assertion('wrong_type', 'Regra NFE não interfere no CT-e', 'sucesso', wrongType.status),
          assertion('document_missing', 'DocumentRule ausente gera erro', 'ERR-4004', documentMissing.codigo),
          assertion('document_supplied', 'DocumentRule suplementada libera averbação', 'sucesso', documentSupplied.status)
        ]
      };
    }
  });

  const requiredCases: Array<{
    id: string;
    key: string;
    label: string;
    missingLabel: string;
    suppliedKey: string;
    value: string;
  }> = [
    {
      id: 'P1-REQUIRED-PLATE',
      key: 'regras:placa',
      label: 'Placa obrigatória',
      missingLabel: 'Placa do Veículo',
      suppliedKey: 'PLACA',
      value: 'ABC1D23'
    },
    {
      id: 'P1-REQUIRED-DRIVER',
      key: 'regras:motorista',
      label: 'Motorista obrigatório',
      missingLabel: 'Motorista (CPF/CNPJ)',
      suppliedKey: 'MOTORISTA',
      value: '12345678901'
    },
    {
      id: 'P1-REQUIRED-SHIPMENT',
      key: 'regras:embarque',
      label: 'Data de embarque obrigatória',
      missingLabel: 'Data de Embarque',
      suppliedKey: 'DATA_EMBARQUE',
      value: brDateFromNow(1)
    }
  ];

  for (const item of requiredCases) {
    scenarios.push({
      id: item.id,
      suite_key: 'p1-required-data',
      priority: 'P1',
      title: item.label,
      description: 'Valida ausência e posterior preenchimento suplementar da variável.',
      tags: ['required-data', 'recovery'],
      covers_flag_keys: [item.key],
      execute: () => {
        const ctx = setupBase();
        setBusinessConfig(ctx, { [item.key]: true });
        const missing = processAverbacao(ctx, { documentNumber: 571001 });
        const supplied = processAverbacao(
          ctx,
          { documentNumber: 571002 },
          { supplemented_vars: { [item.suppliedKey]: item.value } }
        );
        return {
          assertions: [
            assertion('missing_status', 'Ausência gera erro', 'erro', missing.status),
            assertion('missing_code', 'Código de variável faltante', 'ERR-4004', missing.codigo),
            includesAssertion('missing_variable', 'Variável indicada', item.missingLabel, missing.variaveis_faltantes),
            assertion('supplied_status', 'Preenchimento suplementar permite processar', 'sucesso', supplied.status)
          ]
        };
      }
    });
  }

  scenarios.push({
    id: 'P1-DEADLINE-ISSUANCE-BOUNDARY',
    suite_key: 'p1-deadlines',
    priority: 'P1',
    title: 'Prazo de emissão',
    description: 'Documento fora da janela deve ser recusado; documento dentro da janela deve passar.',
    tags: ['deadline', 'boundary'],
    covers_flag_keys: ['regras:prazo-valor', 'regras:prazo-unidade', 'regras:prazo-campo'],
    execute: () => {
      const lateCtx = setupBase();
      setBusinessConfig(lateCtx, {
        'regras:prazo-valor': 1,
        'regras:prazo-unidade': 'Dias',
        'regras:prazo-campo': 'dhEmi'
      });
      const late = processAverbacao(lateCtx, {
        emissionDate: isoFromNow(-3 * 24 * 60 * 60 * 1000),
        documentNumber: 572001
      });

      const onTimeCtx = setupBase();
      setBusinessConfig(onTimeCtx, {
        'regras:prazo-valor': 1,
        'regras:prazo-unidade': 'Dias',
        'regras:prazo-campo': 'dhEmi'
      });
      const onTime = processAverbacao(onTimeCtx, {
        emissionDate: isoFromNow(-30 * 60 * 1000),
        documentNumber: 572002
      });

      return {
        assertions: [
          assertion('late_status', 'Fora do prazo', 'erro', late.status),
          assertion('late_code', 'Código de prazo', 'ERR-4014', late.codigo),
          assertion('on_time', 'Dentro do prazo', 'sucesso', onTime.status)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-DEADLINE-SHIPMENT',
    suite_key: 'p1-deadlines',
    priority: 'P1',
    title: 'Prazo relativo ao embarque',
    description: 'Valida prazo no dia e tolerância de dias após o embarque.',
    tags: ['deadline', 'shipment'],
    covers_flag_keys: ['regras:prazo-embarque', 'regras:dias-apos', 'regras:embarque'],
    execute: () => {
      const expiredCtx = setupBase();
      setBusinessConfig(expiredCtx, {
        'regras:embarque': true,
        'regras:prazo-embarque': 'dia'
      });
      const expired = processAverbacao(expiredCtx, {
        observationOverride: 'DATA_EMBARQUE=' + brDateFromNow(-1),
        documentNumber: 572101
      });

      const toleratedCtx = setupBase();
      setBusinessConfig(toleratedCtx, {
        'regras:embarque': true,
        'regras:prazo-embarque': 'apos',
        'regras:dias-apos': 2
      });
      const tolerated = processAverbacao(toleratedCtx, {
        observationOverride: 'DATA_EMBARQUE=' + brDateFromNow(-1),
        documentNumber: 572102
      });

      return {
        assertions: [
          assertion('expired_status', 'Prazo no dia expirado', 'erro', expired.status),
          assertion('expired_code', 'Código do embarque', 'ERR-4015', expired.codigo),
          assertion('tolerated_status', 'Dentro da tolerância após embarque', 'sucesso', tolerated.status)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-CANCELLATION-DEADLINE',
    suite_key: 'p1-deadlines',
    priority: 'P1',
    title: 'Prazo de cancelamento self-service',
    description: 'Segurado pode cancelar dentro da janela e é bloqueado depois dela.',
    tags: ['deadline', 'cancellation'],
    covers_flag_keys: [
      'regras:cancelamento-sem-limite',
      'regras:prazo-cancelamento-valor',
      'regras:prazo-cancelamento-unidade'
    ],
    execute: () => {
      const insideCtx = setupBase();
      setBusinessConfig(insideCtx, {
        'regras:prazo-cancelamento-valor': 24,
        'regras:prazo-cancelamento-unidade': 'Horas'
      });
      const insideResult = processAverbacao(insideCtx, { documentNumber: 573001 });
      const insideRecord = successfulAverbacaoFromResponse(insideResult);
      const insideCancel = CancelamentoService.processar({
        averbacaoAnterior: insideRecord,
        xmlEvento: cancellationXml(insideRecord.chave_documento || ''),
        requisitante: 'SEGURADO'
      });

      const outsideCtx = setupBase();
      setBusinessConfig(outsideCtx, {
        'regras:prazo-cancelamento-valor': 1,
        'regras:prazo-cancelamento-unidade': 'Horas'
      });
      const outsideResult = processAverbacao(outsideCtx, { documentNumber: 573002 });
      const outsideRecord = successfulAverbacaoFromResponse(outsideResult);
      outsideRecord.timestamp = isoFromNow(-2 * 60 * 60 * 1000);
      const outsideCancel = CancelamentoService.processar({
        averbacaoAnterior: outsideRecord,
        xmlEvento: cancellationXml(outsideRecord.chave_documento || ''),
        requisitante: 'SEGURADO'
      });

      const unlimitedCtx = setupBase();
      setBusinessConfig(unlimitedCtx, {
        'regras:cancelamento-sem-limite': true
      });
      const unlimitedResult = processAverbacao(unlimitedCtx, { documentNumber: 573003 });
      const unlimitedRecord = successfulAverbacaoFromResponse(unlimitedResult);
      unlimitedRecord.timestamp = isoFromNow(-400 * 24 * 60 * 60 * 1000);
      const unlimitedCancel = CancelamentoService.processar({
        averbacaoAnterior: unlimitedRecord,
        xmlEvento: cancellationXml(unlimitedRecord.chave_documento || ''),
        requisitante: 'SEGURADO'
      });

      return {
        assertions: [
          assertion('inside', 'Cancelamento dentro da janela', 'sucesso', insideCancel.status),
          assertion('inside_record', 'Status final cancelado', 'CANCELADO', insideCancel.averbacao?.status),
          assertion('outside', 'Cancelamento fora da janela', 'erro', outsideCancel.status),
          assertion('outside_code', 'Código fora do prazo', 'ERR-4018', outsideCancel.codigo),
          assertion('unlimited', 'Cancelamento explicitamente sem limite', 'sucesso', unlimitedCancel.status)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-COVERAGE-MONETARY-SUM',
    suite_key: 'p1-coverages',
    priority: 'P1',
    title: 'Cobertura monetária compõe valor considerado',
    description: 'Cobertura monetária informada deve ser somada antes do cálculo final.',
    tags: ['coverage', 'value'],
    covers_flag_keys: ['coverage.valor', 'coverage.tipo_valor'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      dbStore.insurerCoverages = [
        {
          id: 'lab-cov-money',
          insurer_id: ctx.insurerAId,
          ramo: 'RCTRC',
          titulo: 'ADICIONAL_TESTE',
          obrigatoria: false,
          aplicar_todos_clientes: true,
          tipo_valor: 'monetario',
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-cov-info',
          insurer_id: ctx.insurerAId,
          ramo: 'RCTRC',
          titulo: 'INFO_TESTE',
          obrigatoria: false,
          aplicar_todos_clientes: true,
          tipo_valor: 'informativo',
          created_at: new Date().toISOString()
        }
      ];
      const result = processAverbacao(
        ctx,
        { valorCarga: 1000 },
        { supplemented_vars: { ADICIONAL_TESTE: 'R$ 200,00', INFO_TESTE: 'R$ 900,00' } }
      );
      return {
        assertions: [
          assertion('status', 'Status', 'sucesso', result.status),
          assertion('value', 'Somente cobertura monetária compõe valor', 1200, result.valor_considerado_averbacao)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-COVERAGE-REQUIRED',
    suite_key: 'p1-coverages',
    priority: 'P1',
    title: 'Cobertura obrigatória ausente',
    description: 'Cobertura obrigatória da seguradora deve gerar recuperação ERR-4004 quando ausente.',
    tags: ['coverage', 'required'],
    covers_flag_keys: ['coverage.obrigatoria'],
    execute: () => {
      const ctx = setupBase();
      dbStore.insurerCoverages = [
        {
          id: 'lab-cov-required',
          insurer_id: ctx.insurerAId,
          ramo: 'RCTRC',
          titulo: 'COBERTURA_OBRIGATORIA',
          obrigatoria: true,
          aplicar_todos_clientes: true,
          tipo_valor: 'informativo',
          created_at: new Date().toISOString()
        }
      ];
      const result = processAverbacao(ctx);
      return {
        assertions: [
          assertion('status', 'Status', 'erro', result.status),
          assertion('codigo', 'Código', 'ERR-4004', result.codigo),
          includesAssertion('missing', 'Cobertura indicada', 'COBERTURA_OBRIGATORIA', result.variaveis_faltantes)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-COVERAGE-SCOPE',
    suite_key: 'p1-coverages',
    priority: 'P1',
    title: 'Escopo de cobertura por segurado e ramo',
    description: 'Somente coberturas globais ou do tenant/ramo correspondente devem afetar a averbação.',
    tags: ['coverage', 'scope'],
    covers_flag_keys: ['coverage.aplicar_todos_clientes', 'coverage.ramo'],
    execute: () => {
      const ctx = setupBase();
      dbStore.insurerCoverages = [
        {
          id: 'lab-cov-global',
          insurer_id: ctx.insurerAId,
          ramo: 'RCTRC',
          titulo: 'GLOBAL',
          obrigatoria: false,
          aplicar_todos_clientes: true,
          tipo_valor: 'monetario',
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-cov-tenant',
          insurer_id: ctx.insurerAId,
          ramo: 'RCTRC',
          titulo: 'TENANT_ONLY',
          obrigatoria: false,
          aplicar_todos_clientes: false,
          tenant_id: ctx.tenantId,
          tipo_valor: 'monetario',
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-cov-other-tenant',
          insurer_id: ctx.insurerAId,
          ramo: 'RCTRC',
          titulo: 'OTHER_TENANT_REQUIRED',
          obrigatoria: true,
          aplicar_todos_clientes: false,
          tenant_id: 'other-tenant',
          tipo_valor: 'monetario',
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-cov-wrong-branch',
          insurer_id: ctx.insurerAId,
          ramo: 'RCDC',
          titulo: 'WRONG_BRANCH_REQUIRED',
          obrigatoria: true,
          aplicar_todos_clientes: true,
          tipo_valor: 'monetario',
          created_at: new Date().toISOString()
        }
      ];

      const result = processAverbacao(
        ctx,
        { valorCarga: 1000 },
        {
          supplemented_vars: {
            GLOBAL: 'R$ 100,00',
            TENANT_ONLY: 'R$ 200,00',
            OTHER_TENANT_REQUIRED: 'R$ 300,00',
            WRONG_BRANCH_REQUIRED: 'R$ 400,00'
          }
        }
      );

      return {
        assertions: [
          assertion('status', 'Coberturas fora do escopo não bloqueiam', 'sucesso', result.status),
          assertion('value', 'Somente global + tenant/ramo correto são somados', 1300, result.valor_considerado_averbacao)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-MULTICHANNEL-DOCUMENT-TYPES',
    suite_key: 'p0-multichannel',
    priority: 'P0',
    title: 'Tipos de documento aceitos na seleção automática',
    description: 'Configuração de documentos aceitos controla quais DF-e podem selecionar a apólice.',
    tags: ['document', 'matching'],
    covers_flag_keys: ['regras:documentos-aceitos', 'document.tipo'],
    execute: () => {
      const ctx = setupBase();
      dbStore.policies = [mainPolicy(ctx)];
      setBusinessConfig(ctx, {
        'regras:documentos-aceitos': ['CT-e', 'NF-e', 'MDF-e', 'NFS-e']
      });

      const types: TipoDocumento[] = ['CTE', 'NFE', 'MDFE', 'NFSE'];
      const counts = Object.fromEntries(
        types.map((type) => [
          type,
          ConnectorFiscalService.resolveAutomaticPolicies(ctx.tenantId, type).length
        ])
      );

      setBusinessConfig(ctx, {
        'regras:documentos-aceitos': ['CT-e']
      });
      const nfeBlocked = ConnectorFiscalService.resolveAutomaticPolicies(ctx.tenantId, 'NFE').length;

      return {
        assertions: [
          assertion('cte', 'CT-e seleciona apólice', 1, counts.CTE),
          assertion('nfe', 'NF-e seleciona apólice', 1, counts.NFE),
          assertion('mdfe', 'MDF-e seleciona apólice', 1, counts.MDFE),
          assertion('nfse', 'NFS-e seleciona apólice', 1, counts.NFSE),
          assertion('blocked', 'Tipo não configurado não seleciona apólice', 0, nfeBlocked)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-MULTICHANNEL-DEDUPE',
    suite_key: 'p0-multichannel',
    priority: 'P0',
    title: 'Deduplicação entre canais',
    description: 'Mesmo XML por Portal, TMS, WhatsApp e SEFAZ deve gerar somente uma averbação efetiva.',
    tags: ['ingestion', 'idempotency'],
    covers_flag_keys: ['ingestion.channel', 'ingestion.deduplication'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      dbStore.policies = [mainPolicy(ctx)];
      const xml = makeXml(ctx, { documentNumber: 574001 });
      const policy = mainPolicy(ctx);
      const target = [{ id: policy.id, numero_apolice: policy.numero_apolice, ramo: policy.ramo }];
      const sources = ['PORTAL', 'TMS', 'WHATSAPP', 'SEFAZ'] as const;
      const duplicateFlags: boolean[] = [];

      for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index]!;
        const [result] = DocumentIngestionService.processXmlBatch({
          tenant_id: ctx.tenantId,
          source,
          app_base_url: 'http://localhost:3000',
          files: [
            {
              filename: source + '-lab.xml',
              xml_content: xml,
              capture_mode: source === 'PORTAL' ? 'MANUAL' : 'INTEGRATION',
              external_id: source + '-574001'
            }
          ],
          policies: target
        });
        duplicateFlags.push(Boolean(result?.duplicate));
      }

      const successCount = dbStore.averbacoes.filter((item) => item.status === 'SUCESSO').length;
      return {
        assertions: [
          assertion('first', 'Primeiro canal não é duplicado', false, duplicateFlags[0]),
          assertion('second', 'Segundo canal é duplicado', true, duplicateFlags[1]),
          assertion('third', 'Terceiro canal é duplicado', true, duplicateFlags[2]),
          assertion('fourth', 'Quarto canal é duplicado', true, duplicateFlags[3]),
          assertion('single_success', 'Somente uma averbação efetiva', 1, successCount)
        ],
        evidence: { duplicateFlags }
      };
    }
  });

  scenarios.push({
    id: 'P0-OUTBOUND-AUTHORIZATION',
    suite_key: 'p0-multichannel',
    priority: 'P0',
    title: 'OUTBOUND exige autorização SEFAZ',
    description: 'Capture OUTBOUND com protocolo/cStat autorizado passa; sem autorização é ignorado.',
    tags: ['outbound', 'sefaz'],
    covers_flag_keys: ['document.autorizacao_sefaz', 'ingestion.channel'],
    quick: true,
    execute: () => {
      const authorizedCtx = setupBase();
      dbStore.policies = [mainPolicy(authorizedCtx)];
      const connector: Connector = {
        id: 'lab-connector',
        tenant_id: authorizedCtx.tenantId,
        device_id: 'lab-device',
        device_name: 'LAB DEVICE',
        version: '1.0.0',
        os: 'windows',
        capabilities: ['CTE_DFE'],
        status: 'ATIVO',
        device_token_hash: 'hash',
        sefaz_status: 'ONLINE',
        certificate_status: 'NAO_CONFIGURADO',
        created_at: new Date().toISOString()
      };
      const authorized = ConnectorFiscalService.ingestBatch({
        connector,
        provider: 'CTE',
        capture_mode: 'OUTBOUND',
        app_base_url: 'http://localhost:3000',
        documents: [
          {
            external_id: 'authorized',
            xml: makeXml(authorizedCtx, {
              documentNumber: 574101,
              incluirProtocoloSefaz: true,
              cStatSefaz: '100'
            })
          }
        ]
      })[0];
      const authorizedDoc = authorized
        ? dbStore.fiscalDocuments.find((item) => item.id === authorized.fiscal_document_id)
        : undefined;

      const deniedCtx = setupBase();
      dbStore.policies = [mainPolicy(deniedCtx)];
      const deniedConnector: Connector = { ...connector, tenant_id: deniedCtx.tenantId };
      const denied = ConnectorFiscalService.ingestBatch({
        connector: deniedConnector,
        provider: 'CTE',
        capture_mode: 'OUTBOUND',
        app_base_url: 'http://localhost:3000',
        documents: [
          {
            external_id: 'denied',
            xml: makeXml(deniedCtx, {
              documentNumber: 574102,
              incluirProtocoloSefaz: false,
              cStatSefaz: '204'
            })
          }
        ]
      })[0];
      const deniedDoc = denied
        ? dbStore.fiscalDocuments.find((item) => item.id === denied.fiscal_document_id)
        : undefined;

      return {
        assertions: [
          assertion('authorized', 'Autorizado', 'AVERBADO', authorizedDoc?.status),
          assertion('denied', 'Não autorizado', 'IGNORADO', deniedDoc?.status),
          assertion('denied_code', 'Motivo de não autorização', 'SEFAZ_NOT_AUTHORIZED', deniedDoc?.codigo_resultado)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-SEFAZ-NSU-RATE-LIMIT',
    suite_key: 'p1-sefaz-contract',
    priority: 'P1',
    title: 'Distribuição DF-e e consumo indevido',
    description: 'Mock SEFAZ deve entregar 138, depois 137 e bloquear nova consulta imediata com 656.',
    tags: ['sefaz', 'nsu'],
    covers_flag_keys: ['document.autorizacao_sefaz', 'ingestion.channel'],
    execute: () => {
      const service = new MockSefazService();
      const cnpj = '12345678000190';
      const first = service.distribute({
        provider: 'CTE',
        cnpj,
        ult_nsu: '000000000000000'
      });
      const second = service.distribute({
        provider: 'CTE',
        cnpj,
        ult_nsu: first.ultNSU
      });
      const third = service.distribute({
        provider: 'CTE',
        cnpj,
        ult_nsu: second.ultNSU
      });

      return {
        assertions: [
          assertion('first', 'Primeira distribuição', 138, first.cStat),
          assertion('documents', 'Primeira distribuição possui documentos', true, first.documents.length > 0),
          assertion('second', 'Fim da fila', 137, second.cStat),
          assertion('third', 'Consulta precoce bloqueada', 656, third.cStat)
        ],
        evidence: { ultNSU: first.ultNSU, maxNSU: first.maxNSU }
      };
    }
  });

  scenarios.push({
    id: 'P1-SEFAZ-HOMOLOGATION',
    suite_key: 'p1-sefaz-contract',
    priority: 'P1',
    title: 'Documento de homologação',
    description: 'tpAmb=2 deve permanecer rastreado como teste e nunca aparentar averbação produtiva.',
    tags: ['sefaz', 'environment'],
    covers_flag_keys: ['document.tp_amb'],
    execute: () => {
      const ctx = setupBase();
      const result = processAverbacao(ctx, { tpAmbSefaz: 2 });
      const record = successfulAverbacaoFromResponse(result);
      return {
        assertions: [
          assertion('tpamb', 'tpAmb persistido', 2, record.tp_amb_sefaz),
          assertion('prefix', 'Prefixo TESTE', true, Boolean(record.numero_averbacao?.startsWith('TESTE-')))
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-ACCESS-INSURER-POLICY-ISOLATION',
    suite_key: 'p0-access-isolation',
    priority: 'P0',
    title: 'Isolamento Seguradora A x Seguradora B',
    description: 'Mesmo segurado pode ter apólices de seguradoras diferentes sem compartilhar averbações.',
    tags: ['security', 'rbac'],
    covers_flag_keys: ['access.insurer_policy_isolation', 'access.aggregate_isolation'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      const policyA = mainPolicy(ctx);
      const policyB: Policy = {
        ...policyA,
        id: 'lab-policy-b-rcdc',
        numero_apolice: 'LAB-B-RCDC-001',
        ramo: 'RCDC',
        insurer_id: ctx.insurerBId
      };
      dbStore.policies = [policyA, policyB];

      dbStore.averbacoes = [
        {
          id: 'lab-avb-a',
          tenant_id: ctx.tenantId,
          policy_id: policyA.id,
          protocolo_interno_averbacao: 'PI-A',
          numero_averbacao: 'AVB-A',
          status: 'SUCESSO',
          codigo_resposta: 'SUC-2000',
          mensagem_resposta: 'OK',
          valor_carga: 1000,
          valor_considerado_averbacao: 1000,
          ambiente: 'teste',
          timestamp: new Date().toISOString(),
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-avb-b',
          tenant_id: ctx.tenantId,
          policy_id: policyB.id,
          protocolo_interno_averbacao: 'PI-B',
          numero_averbacao: 'AVB-B',
          status: 'SUCESSO',
          codigo_resposta: 'SUC-2000',
          mensagem_resposta: 'OK',
          valor_carga: 3000,
          valor_considerado_averbacao: 3000,
          ambiente: 'teste',
          timestamp: new Date().toISOString(),
          created_at: new Date().toISOString()
        }
      ] as any;

      const listA = InsurerVisibilityService.averbacoes(ctx.insurerAId);
      const listB = InsurerVisibilityService.averbacoes(ctx.insurerBId);
      const aggregateA = InsurerVisibilityService.aggregate(ctx.insurerAId);
      const aggregateB = InsurerVisibilityService.aggregate(ctx.insurerBId);

      return {
        assertions: [
          assertion('list_a', 'Seguradora A vê somente A', ['lab-avb-a'], listA.map((item) => item.id)),
          assertion('list_b', 'Seguradora B vê somente B', ['lab-avb-b'], listB.map((item) => item.id)),
          assertion('value_a', 'Agregado A não soma B', 1000, aggregateA.valor_total_averbado),
          assertion('value_b', 'Agregado B não soma A', 3000, aggregateB.valor_total_averbado)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-ACCESS-IDOR',
    suite_key: 'p0-access-isolation',
    priority: 'P0',
    title: 'Bloqueio de IDOR entre seguradoras',
    description: 'Conhecer o ID de apólice/averbação de outra seguradora não concede acesso.',
    tags: ['security', 'idor'],
    covers_flag_keys: ['access.direct_object_reference'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      const policyA = mainPolicy(ctx);
      const policyB: Policy = {
        ...policyA,
        id: 'lab-policy-b-idor',
        numero_apolice: 'LAB-B-IDOR',
        ramo: 'RCDC',
        insurer_id: ctx.insurerBId
      };
      dbStore.policies = [policyA, policyB];
      dbStore.averbacoes = [
        {
          id: 'lab-avb-b-idor',
          tenant_id: ctx.tenantId,
          policy_id: policyB.id,
          protocolo_interno_averbacao: 'PI-B-IDOR',
          status: 'SUCESSO',
          codigo_resposta: 'SUC-2000',
          mensagem_resposta: 'OK',
          valor_carga: 100,
          ambiente: 'teste',
          timestamp: new Date().toISOString(),
          created_at: new Date().toISOString()
        }
      ] as any;

      return {
        assertions: [
          assertion('policy', 'A não acessa apólice B', false, InsurerVisibilityService.canAccessPolicy(ctx.insurerAId, policyB.id)),
          assertion('avb', 'A não acessa averbação B', false, InsurerVisibilityService.canAccessAverbacao(ctx.insurerAId, 'lab-avb-b-idor')),
          assertion('owner', 'B acessa própria averbação', true, InsurerVisibilityService.canAccessAverbacao(ctx.insurerBId, 'lab-avb-b-idor'))
        ]
      };
    }
  });

  scenarios.push({
    id: 'P0-ACCESS-SAME-BRANCH-AMBIGUOUS',
    suite_key: 'p0-access-isolation',
    priority: 'P0',
    title: 'Mesmo segurado + mesmo ramo + duas seguradoras',
    description: 'Seleção automática deve se recusar a escolher uma seguradora arbitrariamente.',
    tags: ['security', 'matching'],
    covers_flag_keys: ['access.same_tenant_same_branch_two_insurers'],
    quick: true,
    execute: () => {
      const ctx = setupBase();
      const policyA = mainPolicy(ctx);
      const policyB: Policy = {
        ...policyA,
        id: 'lab-policy-b-rctrc',
        numero_apolice: 'LAB-B-RCTRC-001',
        insurer_id: ctx.insurerBId
      };
      dbStore.policies = [policyA, policyB];
      const resolved = ConnectorFiscalService.resolveAutomaticPolicies(ctx.tenantId, 'CTE');
      return {
        assertions: [
          assertion('ambiguous', 'Nenhuma apólice selecionada automaticamente', 0, resolved.length)
        ],
        evidence: { candidates: [policyA.id, policyB.id] }
      };
    }
  });

  scenarios.push({
    id: 'P0-ACCESS-TENANT-FILTER',
    suite_key: 'p0-access-isolation',
    priority: 'P0',
    title: 'Filtro de segurado não amplia escopo',
    description: 'tenant_id compartilhado nunca deve trazer apólices/averbações de outra seguradora.',
    tags: ['security', 'filter'],
    covers_flag_keys: ['access.insurer_policy_isolation', 'access.aggregate_isolation'],
    execute: () => {
      const ctx = setupBase();
      const policyA = mainPolicy(ctx);
      const policyB: Policy = {
        ...policyA,
        id: 'lab-policy-b-filter',
        numero_apolice: 'LAB-B-FILTER',
        ramo: 'RCDC',
        insurer_id: ctx.insurerBId
      };
      dbStore.policies = [policyA, policyB];
      dbStore.averbacoes = [
        {
          id: 'lab-filter-a',
          tenant_id: ctx.tenantId,
          policy_id: policyA.id,
          protocolo_interno_averbacao: 'PI-A',
          status: 'SUCESSO',
          codigo_resposta: 'SUC-2000',
          mensagem_resposta: 'OK',
          valor_carga: 10,
          ambiente: 'teste',
          timestamp: new Date().toISOString(),
          created_at: new Date().toISOString()
        },
        {
          id: 'lab-filter-b',
          tenant_id: ctx.tenantId,
          policy_id: policyB.id,
          protocolo_interno_averbacao: 'PI-B',
          status: 'SUCESSO',
          codigo_resposta: 'SUC-2000',
          mensagem_resposta: 'OK',
          valor_carga: 20,
          ambiente: 'teste',
          timestamp: new Date().toISOString(),
          created_at: new Date().toISOString()
        }
      ] as any;

      const filteredA = InsurerVisibilityService.averbacoes(ctx.insurerAId, {
        tenant_id: ctx.tenantId
      });
      return {
        assertions: [
          assertion('scope', 'Filtro mantém somente a seguradora A', ['lab-filter-a'], filteredA.map((item) => item.id))
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-PORTAL-UI-LIMIT-ALIASES',
    suite_key: 'p1-portal-ui-contract',
    priority: 'P1',
    title: 'Compatibilidade das chaves de Tratamento de Recusas da UI',
    description: 'Prova que as chaves recusas:* persistidas pelo Portal são normalizadas e realmente alteram o motor.',
    tags: ['portal-contract', 'compatibility', 'limits'],
    covers_flag_keys: [
      'recusas:estrategia-lmg',
      'recusas:sem-codigo-modo',
      'recusas:teto-valor',
      'recusas:teto-acima-acao',
      'recusas:fila-aprovacao'
    ],
    execute: () => {
      const ctx = setupBase({ lmi: 1000 });
      setBusinessConfig(ctx, {
        'recusas:estrategia-lmg': 'limite-apolice',
        'recusas:sem-codigo-modo': 'teto',
        'recusas:teto-valor': 'R$ 1.050,00',
        'recusas:teto-acima-acao': 'fila',
        'recusas:fila-aprovacao': true
      });

      const normalized = RuleEngineService.getBusinessConfig(mainPolicy(ctx));
      const limitResult = processAverbacao(ctx, {
        valorCarga: 1200,
        documentNumber: 578001
      });

      const queueCtx = setupBase({ aceita_averbacao_como_destinatario: false });
      setBusinessConfig(queueCtx, {
        'recusas:fila-aprovacao': true
      });
      const queued = processAverbacao(queueCtx, {
        funcaoTenant: 'DESTINATARIO',
        documentNumber: 578002
      });

      return {
        assertions: [
          assertion('strategy_alias', 'Estratégia UI normalizada', 'truncar', normalized['regras:estrategia-lmg']),
          assertion('mode_alias', 'Modo sem código normalizado', 'teto', normalized['regras:sem-codigo-modo']),
          assertion('threshold_alias', 'Teto monetário convertido', 1050, normalized['regras:teto-valor']),
          assertion('action_alias', 'Ação acima do teto', 'fila', normalized['regras:teto-acima-acao']),
          assertion('queue_alias', 'Fila genérica normalizada', true, normalized['regras:fila-aprovacao-recusas']),
          assertion('limit_status', 'Estratégia da UI chegou ao motor', 'sucesso', limitResult.status),
          assertion('limit_value', 'Valor truncado pelo LMG', 1000, limitResult.valor_considerado_averbacao),
          assertion('queue_status', 'Toggle da UI gera pendência', 'pendente', queued.status)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-PORTAL-UI-DEADLINE-ALIASES',
    suite_key: 'p1-portal-ui-contract',
    priority: 'P1',
    title: 'Compatibilidade das chaves de prazo da UI',
    description: 'Valida prazo-embarque-v2 e o trio modo/valor/unidade usado no cancelamento.',
    tags: ['portal-contract', 'compatibility', 'deadline'],
    covers_flag_keys: [
      'regras:prazo-embarque-v2',
      'regras:modo-canc',
      'regras:canc-valor',
      'regras:canc-unidade'
    ],
    execute: () => {
      const shipmentCtx = setupBase();
      setBusinessConfig(shipmentCtx, {
        'regras:embarque': true,
        'regras:prazo-embarque-v2': 'dia'
      });
      const shipmentConfig = RuleEngineService.getBusinessConfig(mainPolicy(shipmentCtx));
      const shipment = processAverbacao(shipmentCtx, {
        observationOverride: 'DATA_EMBARQUE=' + brDateFromNow(-1),
        documentNumber: 578101
      });

      const cancelCtx = setupBase();
      setBusinessConfig(cancelCtx, {
        'regras:modo-canc': 'prazo',
        'regras:canc-valor': '1',
        'regras:canc-unidade': 'Dias'
      });
      const cancelConfig = RuleEngineService.getBusinessConfig(mainPolicy(cancelCtx));
      const cancelResult = processAverbacao(cancelCtx, { documentNumber: 578102 });
      const cancelRecord = successfulAverbacaoFromResponse(cancelResult);
      cancelRecord.timestamp = isoFromNow(-2 * 24 * 60 * 60 * 1000);
      const cancellation = CancelamentoService.processar({
        averbacaoAnterior: cancelRecord,
        xmlEvento: cancellationXml(cancelRecord.chave_documento || ''),
        requisitante: 'SEGURADO'
      });

      const monthCtx = setupBase();
      setBusinessConfig(monthCtx, {
        'regras:modo-canc': 'prazo',
        'regras:canc-valor': '1',
        'regras:canc-unidade': 'Meses'
      });
      const monthResult = processAverbacao(monthCtx, { documentNumber: 578103 });
      const monthRecord = successfulAverbacaoFromResponse(monthResult);
      monthRecord.timestamp = isoFromNow(-20 * 24 * 60 * 60 * 1000);
      const monthCancellation = CancelamentoService.processar({
        averbacaoAnterior: monthRecord,
        xmlEvento: cancellationXml(monthRecord.chave_documento || ''),
        requisitante: 'SEGURADO'
      });

      const unlimitedCtx = setupBase();
      setBusinessConfig(unlimitedCtx, {
        'regras:modo-canc': 'sem'
      });
      const unlimitedConfig = RuleEngineService.getBusinessConfig(mainPolicy(unlimitedCtx));
      const unlimitedResult = processAverbacao(unlimitedCtx, { documentNumber: 578104 });
      const unlimitedRecord = successfulAverbacaoFromResponse(unlimitedResult);
      unlimitedRecord.timestamp = isoFromNow(-400 * 24 * 60 * 60 * 1000);
      const unlimitedCancellation = CancelamentoService.processar({
        averbacaoAnterior: unlimitedRecord,
        xmlEvento: cancellationXml(unlimitedRecord.chave_documento || ''),
        requisitante: 'SEGURADO'
      });

      return {
        assertions: [
          assertion('shipment_alias', 'Prazo de embarque normalizado', 'dia', shipmentConfig['regras:prazo-embarque']),
          assertion('shipment_result', 'Prazo de embarque da UI aplicado', 'ERR-4015', shipment.codigo),
          assertion('cancel_value', 'Valor de cancelamento normalizado', 1, cancelConfig['regras:prazo-cancelamento-valor']),
          assertion('cancel_unit', 'Unidade de cancelamento normalizada', 'Dias', cancelConfig['regras:prazo-cancelamento-unidade']),
          assertion('cancel_expired', 'Prazo em dias bloqueia após vencimento', 'ERR-4018', cancellation.codigo),
          assertion('cancel_months', 'Unidade Meses é respeitada', 'sucesso', monthCancellation.status),
          assertion('cancel_unlimited_alias', 'Modo sem limite normalizado', true, unlimitedConfig['regras:cancelamento-sem-limite']),
          assertion('cancel_unlimited_result', 'Modo sem limite da UI é respeitado', 'sucesso', unlimitedCancellation.status)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-TITULARITY-ALLOWED-FUNCTIONS',
    suite_key: 'p1-titularity-bypass',
    priority: 'P1',
    title: 'Regra A — funções autorizadas do CNPJ',
    description: 'PolicyTitularityRule habilitada deve aceitar a função configurada e bloquear função não habilitada.',
    tags: ['titularity', 'regra-a'],
    covers_flag_keys: ['titularity.allowed_functions'],
    execute: () => {
      const allowedCtx = setupBase({ aceita_averbacao_como_destinatario: false });
      dbStore.policyTitularityRules = [
        {
          id: 'lab-titularity-tomador',
          policy_id: allowedCtx.policyId,
          funcao: 'TOMADOR',
          habilitada: true
        }
      ];
      const allowed = processAverbacao(allowedCtx, {
        funcaoTenant: 'TOMADOR',
        documentNumber: 576001
      });

      const deniedCtx = setupBase({ aceita_averbacao_como_destinatario: true });
      dbStore.policyTitularityRules = [
        {
          id: 'lab-titularity-tomador-only',
          policy_id: deniedCtx.policyId,
          funcao: 'TOMADOR',
          habilitada: true
        }
      ];
      const denied = processAverbacao(deniedCtx, {
        funcaoTenant: 'DESTINATARIO',
        documentNumber: 576002
      });

      return {
        assertions: [
          assertion('allowed', 'Tomador habilitado passa', 'sucesso', allowed.status),
          assertion('denied', 'Destinatário não habilitado é bloqueado', 'erro', denied.status),
          assertion('denied_code', 'Código de titularidade preservado', 'ERR-4008', denied.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-BYPASS-ROUTE',
    suite_key: 'p1-titularity-bypass',
    priority: 'P1',
    title: 'Regra B — bypass por rota',
    description: 'Documento sem CNPJ do segurado só deve passar quando UF origem/destino correspondem ao bypass.',
    tags: ['titularity', 'regra-b', 'route'],
    covers_flag_keys: ['bypass.route'],
    execute: () => {
      const matchCtx = setupBase();
      dbStore.policyBypassRules = [
        {
          id: 'lab-bypass-route',
          policy_id: matchCtx.policyId,
          rota_uf_origem: 'SP',
          rota_uf_destino: 'MG'
        }
      ];
      const match = processAverbacao(matchCtx, {
        omitirCnpjTenant: true,
        ufOrigem: 'SP',
        ufDestino: 'MG',
        documentNumber: 576101
      });

      const mismatchCtx = setupBase();
      dbStore.policyBypassRules = [
        {
          id: 'lab-bypass-route-mismatch',
          policy_id: mismatchCtx.policyId,
          rota_uf_origem: 'SP',
          rota_uf_destino: 'RJ'
        }
      ];
      const mismatch = processAverbacao(mismatchCtx, {
        omitirCnpjTenant: true,
        ufOrigem: 'SP',
        ufDestino: 'MG',
        documentNumber: 576102
      });

      return {
        assertions: [
          assertion('match', 'Rota compatível libera', 'sucesso', match.status),
          assertion('mismatch', 'Rota divergente bloqueia', 'erro', mismatch.status),
          assertion('mismatch_code', 'Código de titularidade', 'ERR-4008', mismatch.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-BYPASS-PRODUCT',
    suite_key: 'p1-titularity-bypass',
    priority: 'P1',
    title: 'Regra B — bypass por produto predominante',
    description: 'Documento sem CNPJ do segurado só deve passar quando o produto predominante corresponde ao bypass.',
    tags: ['titularity', 'regra-b', 'product'],
    covers_flag_keys: ['bypass.product'],
    execute: () => {
      const matchCtx = setupBase();
      dbStore.policyBypassRules = [
        {
          id: 'lab-bypass-product',
          policy_id: matchCtx.policyId,
          produto_predominante: 'ELETRONICOS'
        }
      ];
      const match = processAverbacao(matchCtx, {
        omitirCnpjTenant: true,
        produtoPredominante: 'ELETRONICOS',
        documentNumber: 576201
      });

      const mismatchCtx = setupBase();
      dbStore.policyBypassRules = [
        {
          id: 'lab-bypass-product-mismatch',
          policy_id: mismatchCtx.policyId,
          produto_predominante: 'ALIMENTOS'
        }
      ];
      const mismatch = processAverbacao(mismatchCtx, {
        omitirCnpjTenant: true,
        produtoPredominante: 'ELETRONICOS',
        documentNumber: 576202
      });

      return {
        assertions: [
          assertion('match', 'Produto compatível libera', 'sucesso', match.status),
          assertion('mismatch', 'Produto divergente bloqueia', 'erro', mismatch.status),
          assertion('mismatch_code', 'Código de titularidade', 'ERR-4008', mismatch.codigo)
        ]
      };
    }
  });

  scenarios.push({
    id: 'P1-CATALOG-AUDIT',
    suite_key: 'p1-catalog-governance',
    priority: 'P1',
    title: 'Nenhuma regra backend sem catálogo',
    description: 'Falha quando uma nova chave regras:* é criada e esquecida no Laboratório.',
    tags: ['catalog', 'ci'],
    covers_flag_keys: [],
    execute: () => {
      const audit = TestLabCatalogAuditService.audit();
      return {
        assertions: [
          assertion('audit', 'Chaves não catalogadas', [], audit.uncatalogued_business_keys)
        ],
        evidence: audit as unknown as Record<string, unknown>
      };
    }
  });

  return scenarios;
}

export class TestLabRunnerService {
  static plan(request: TestLabPlanRequest = {}): TestLabPlan {
    const catalog = getTestLabCatalog();
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('TEST_LAB_INVALID_REQUEST');
    if (request.mode && !['QUICK', 'STANDARD', 'EXHAUSTIVE'].includes(request.mode)) throw new Error('TEST_LAB_INVALID_MODE');
    for (const field of ['suite_keys', 'selected_flag_keys', 'only_scenario_ids'] as const) {
      const values = request[field];
      if (values !== undefined && (!Array.isArray(values) || !values.length || values.length > 2000 || values.some(v => typeof v !== 'string'))) {
        throw new Error('TEST_LAB_INVALID_SELECTION');
      }
    }
    if (request.suite_keys?.some(key => !catalog.suites.some(s => s.key === key && s.priority !== 'P2'))) throw new Error('TEST_LAB_UNKNOWN_SUITE');
    if (request.selected_flag_keys?.some(key => !catalog.flags.some(f => f.key === key))) throw new Error('TEST_LAB_UNKNOWN_FLAG');
    const mode: TestLabMode = request.mode ?? 'STANDARD';
    const allowedSuites = catalog.suites.filter(
      (suite) => suite.priority === 'P0' || suite.priority === 'P1'
    );
    const suiteKeys =
      request.suite_keys && request.suite_keys.length > 0
        ? request.suite_keys.filter((key) => allowedSuites.some((suite) => suite.key === key))
        : allowedSuites.map((suite) => suite.key);

    const selectedFlagKeys =
      request.selected_flag_keys && request.selected_flag_keys.length > 0
        ? request.selected_flag_keys
        : Array.from(
            new Set(
              allowedSuites
                .filter((suite) => suiteKeys.includes(suite.key))
                .flatMap((suite) => suite.flag_keys)
            )
          );

    let definitions = defineScenarios(mode).filter((scenario) => suiteKeys.includes(scenario.suite_key));

    if (mode === 'QUICK') {
      definitions = definitions.filter((scenario) => scenario.quick === true);
    }

    if (request.selected_flag_keys && request.selected_flag_keys.length > 0) {
      definitions = definitions.filter(
        (scenario) =>
          scenario.covers_flag_keys.length === 0 ||
          scenario.covers_flag_keys.some((key) => selectedFlagKeys.includes(key))
      );
    }

    if (request.only_scenario_ids && request.only_scenario_ids.length > 0) {
      const ids = new Set(request.only_scenario_ids);
      definitions = definitions.filter((scenario) => ids.has(scenario.id));
    }

    if (mode !== 'QUICK' && !(request.only_scenario_ids && request.only_scenario_ids.length > 0)) {
      const covered = new Set(definitions.flatMap((scenario) => scenario.covers_flag_keys));
      const selectedSuites = allowedSuites.filter((suite) => suiteKeys.includes(suite.key));

      for (const suite of selectedSuites) {
        for (const key of suite.flag_keys) {
          if (!selectedFlagKeys.includes(key) || covered.has(key)) continue;
          const flag = catalog.flags.find((item) => item.key === key);
          const priority = suite.priority;
          definitions.push({
            id: 'GAP-' + suite.key + '-' + key.replace(/[^A-Za-z0-9]+/g, '-'),
            suite_key: suite.key,
            priority,
            title: flag ? flag.label : key,
            description: flag
              ? flag.description
              : 'Regra selecionada sem definição no catálogo.',
            tags: ['gap', 'coverage'],
            covers_flag_keys: [key],
            gap_reason:
              flag?.engine_status === 'PLANNED'
                ? 'Configuração existente, mas ainda não aplicada pelo motor.'
                : 'Regra catalogada ainda não possui executor automático.'
          });
        }
      }
    }

    const flagMap = new Map(catalog.flags.map((flag) => [flag.key, flag]));
    const dimensions: ScenarioDimension[] = selectedFlagKeys
      .map((key) => flagMap.get(key))
      .filter((flag): flag is NonNullable<typeof flag> => Boolean(flag))
      .filter((flag) => ['BOOLEAN_BOTH', 'ENUM_ALL', 'NUMERIC_BOUNDARIES', 'DATE_BOUNDARIES', 'PAIRWISE'].includes(flag.generation))
      .map((flag) => ({
        key: flag.key,
        values: TestLabScenarioGenerator.valuesForFlag(flag)
      }));

    const estimatedCartesian = TestLabScenarioGenerator.estimateCartesian(dimensions);
    const estimatedPairwise =
      dimensions.length > 0
        ? TestLabScenarioGenerator.pairwise(dimensions, 5000).length
        : 0;

    return {
      mode,
      suite_keys: suiteKeys,
      selected_flag_keys: selectedFlagKeys,
      total_scenarios: definitions.length,
      p0: definitions.filter((item) => item.priority === 'P0').length,
      p1: definitions.filter((item) => item.priority === 'P1').length,
      estimated_cartesian_cases: estimatedCartesian,
      estimated_pairwise_cases: estimatedPairwise,
      scenarios: definitions.map((item) => ({
        id: item.id,
        suite_key: item.suite_key,
        priority: item.priority,
        title: item.title,
        description: item.description,
        covers_flag_keys: item.covers_flag_keys,
        gap_reason: item.gap_reason
      }))
    };
  }

  static async execute(request: TestLabPlanRequest = {}): Promise<TestLabRun> {
    // Guard the service itself so HTTP, CLI and future callers cannot bypass it.
    for (const name of ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOYMENT_ENV']) {
      const value = process.env[name]?.toLowerCase();
      if (value && !['test', 'teste', 'development', 'dev', 'local', 'staging', 'homologacao', 'homologation'].includes(value)) {
        throw new Error('TEST_LAB_PRODUCTION_BLOCKED');
      }
    }
    const plan = this.plan(request);
    if (!plan.total_scenarios) throw new Error('TEST_LAB_EMPTY_PLAN');
    const allDefinitions = defineScenarios(plan.mode);
    const definitionById = new Map(allDefinitions.map((item) => [item.id, item]));

    const run: TestLabRun = {
      id: 'LAB-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + uuidv4().slice(0, 8),
      mode: plan.mode,
      suite_keys: plan.suite_keys,
      selected_flag_keys: plan.selected_flag_keys,
      status: 'RUNNING',
      environment: 'teste',
      total_planned: plan.total_scenarios,
      total_executed: 0,
      passed: 0,
      failed: 0,
      gaps: 0,
      duration_ms: 0,
      scenario_results: [],
      rerun_of: request.rerun_of,
      created_at: new Date().toISOString()
    };

    dbStore.testLabRuns.unshift(run);
    dbStore.persist();
    const runStarted = Date.now();

    try {
      for (const planned of plan.scenarios) {
        const definition = definitionById.get(planned.id);
        let result: TestLabScenarioResult;

        if (!definition) {
          result = {
            id: planned.id,
            suite_key: planned.suite_key,
            priority: planned.priority,
            title: planned.title,
            description: planned.description,
            tags: ['gap'],
            covers_flag_keys: planned.covers_flag_keys,
            status: 'GAP',
            duration_ms: 0,
            assertions: [],
            error: planned.gap_reason ?? 'Executor automático ausente.'
          };
        } else if (definition.gap_reason || !definition.execute || getTestLabCatalog().flags.some(flag => flag.engine_status === 'PLANNED' && definition.covers_flag_keys.includes(flag.key))) {
          result = {
            id: definition.id,
            suite_key: definition.suite_key,
            priority: definition.priority,
            title: definition.title,
            description: definition.description,
            tags: definition.tags,
            covers_flag_keys: definition.covers_flag_keys,
            status: 'GAP',
            duration_ms: 0,
            assertions: [],
            error: definition.gap_reason ?? 'Configuração sem efeito no motor ou executor automático ausente.'
          };
        } else {
          const started = Date.now();
          try {
            const execution = await dbStore.runTestLabEphemeral(() => definition.execute!());
            const passed = execution.assertions.every((item) => item.pass);
            result = {
              id: definition.id,
              suite_key: definition.suite_key,
              priority: definition.priority,
              title: definition.title,
              description: definition.description,
              tags: definition.tags,
              covers_flag_keys: definition.covers_flag_keys,
              status: execution.assertions.length === 0 ? 'GAP' : passed ? 'PASS' : 'FAIL',
              duration_ms: Date.now() - started,
              assertions: execution.assertions,
              evidence: execution.evidence
            };
          } catch (error) {
            result = {
              id: definition.id,
              suite_key: definition.suite_key,
              priority: definition.priority,
              title: definition.title,
              description: definition.description,
              tags: definition.tags,
              covers_flag_keys: definition.covers_flag_keys,
              status: 'FAIL',
              duration_ms: Date.now() - started,
              assertions: [],
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }

        run.scenario_results.push(result);
        run.total_executed += 1;
        if (result.status === 'PASS') run.passed += 1;
        if (result.status === 'FAIL') run.failed += 1;
        if (result.status === 'GAP') run.gaps += 1;
        run.duration_ms = Date.now() - runStarted;
        dbStore.persist();
      }

      run.status = 'COMPLETED';
      run.completed_at = new Date().toISOString();
      run.duration_ms = Date.now() - runStarted;
      dbStore.persist();
      return run;
    } catch (error) {
      run.status = 'FAILED';
      run.completed_at = new Date().toISOString();
      run.duration_ms = Date.now() - runStarted;
      dbStore.persist();
      throw error;
    }
  }

  static getRun(runId: string): TestLabRun | undefined {
    return dbStore.testLabRuns.find((run) => run.id === runId);
  }

  static history(limit = 50): TestLabRun[] {
    return dbStore.testLabRuns.slice(0, Math.min(Math.max(limit, 1), 200));
  }

  static async rerunFailed(runId: string): Promise<TestLabRun> {
    const original = this.getRun(runId);
    if (!original) throw new Error('TEST_LAB_RUN_NOT_FOUND');
    const failedIds = original.scenario_results
      .filter((result) => result.status === 'FAIL')
      .map((result) => result.id);
    if (failedIds.length === 0) throw new Error('TEST_LAB_NO_FAILED_SCENARIOS');

    return this.execute({
      mode: original.mode,
      suite_keys: original.suite_keys,
      selected_flag_keys: original.selected_flag_keys,
      only_scenario_ids: failedIds,
      rerun_of: original.id
    });
  }

  static exportCsv(runId: string): string {
    const run = this.getRun(runId);
    if (!run) throw new Error('TEST_LAB_RUN_NOT_FOUND');

    const escape = (value: unknown) => {
      const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      return '"' + raw.replace(/"/g, '""') + '"';
    };

    const rows = [
      ['scenario_id', 'suite', 'priority', 'status', 'title', 'duration_ms', 'failed_assertions', 'error']
        .map(escape)
        .join(',')
    ];

    for (const scenario of run.scenario_results) {
      const failedAssertions = scenario.assertions
        .filter((item) => !item.pass)
        .map((item) => ({
          key: item.key,
          expected: item.expected,
          actual: item.actual
        }));
      rows.push(
        [
          scenario.id,
          scenario.suite_key,
          scenario.priority,
          scenario.status,
          scenario.title,
          scenario.duration_ms,
          failedAssertions,
          scenario.error ?? ''
        ]
          .map(escape)
          .join(',')
      );
    }

    return rows.join('\n');
  }
}
