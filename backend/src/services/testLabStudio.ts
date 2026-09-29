import { v4 as uuidv4 } from 'uuid';
import {
  DocumentIngestionSource,
  FuncaoDocumento,
  Policy,
  RamoApolice,
  TipoCondicaoSublimite,
  TipoDocumento
} from '../types';
import { AverbacaoResponseDTO } from './averbacao';
import { withClock } from './clock';
import { dbStore } from './dbStore';
import { DocumentIngestionService } from './ingestion/documentIngestion';
import { getTestLabCatalog, TestLabFlagDefinition } from './testLabCatalog';
import {
  ScenarioAssignment,
  ScenarioDimension,
  ScenarioDimensionValue,
  TestLabScenarioGenerator
} from './testLabScenarioGenerator';
import { TestLabFixtureGenerator } from './testLabFixtureGenerator';

export type TestLabStudioStrategy = 'SINGLE' | 'PAIRWISE' | 'CARTESIAN';

export interface TestLabStudioDimension {
  key: string;
  values: ScenarioDimensionValue[];
}

export interface TestLabStudioSecondaryPolicy {
  enabled?: boolean;
  status?: Policy['status'];
  vigencia_inicio?: string;
  vigencia_fim?: string;
  lmi?: number;
}

export interface TestLabStudioFixture {
  ramo?: RamoApolice;
  matching_mode?: 'AUTO' | 'EXPLICIT';
  observation_text?: string;
  supplemented_vars?: Record<string, unknown>;
  uf_origem?: string;
  uf_destino?: string;
  produto_predominante?: string;
  secondary_policy?: TestLabStudioSecondaryPolicy;
  include_coverage_in_document?: boolean;
}

export interface TestLabStudioExpectation {
  status?: AverbacaoResponseDTO['status'];
  codigo?: string;
  matched_policy?: 'PRIMARY' | 'SECONDARY';
}

export interface TestLabStudioRequest {
  name?: string;
  strategy?: TestLabStudioStrategy;
  reference_date?: string;
  dimensions?: TestLabStudioDimension[];
  fixture?: TestLabStudioFixture;
  expectation?: TestLabStudioExpectation;
  max_cases?: number;
}

export interface TestLabStudioCapability {
  key: string;
  label: string;
  group: string;
  description: string;
  engine_status: TestLabFlagDefinition['engine_status'];
  value_type: TestLabFlagDefinition['value_type'];
  generation: TestLabFlagDefinition['generation'];
  interactive: boolean;
  control: 'BOOLEAN' | 'ENUM' | 'NUMBER' | 'DATE' | 'STRING' | 'MULTISELECT' | 'OFFICIAL_ONLY';
  options?: Array<{ value: ScenarioDimensionValue; label: string }>;
  suggested_values?: ScenarioDimensionValue[];
  reason?: string;
}

export interface TestLabStudioCaseResult {
  index: number;
  assignment: ScenarioAssignment;
  status: 'PASS' | 'FAIL' | 'UNVALIDATED';
  duration_ms: number;
  expected: TestLabStudioExpectation;
  actual: {
    status: AverbacaoResponseDTO['status'];
    codigo: string;
    matched_policy?: 'PRIMARY' | 'SECONDARY' | 'UNKNOWN';
    policy_id?: string;
    mensagem: string;
    valor_considerado_averbacao?: number;
    regras_internas_aplicadas?: string[];
    variaveis_faltantes?: string[];
  };
  assertions: Array<{
    key: string;
    expected: unknown;
    actual: unknown;
    pass: boolean;
  }>;
}

const PRIMARY_POLICY_ID = 'lab-studio-policy-primary';
const SECONDARY_POLICY_ID = 'lab-studio-policy-secondary';
const TENANT_ID = 'lab-studio-tenant';
const INSURER_A_ID = 'lab-studio-insurer-a';
const INSURER_B_ID = 'lab-studio-insurer-b';
const BROKER_ID = 'lab-studio-broker';

const DIRECT_POLICY_KEYS = new Set([
  'policy.status',
  'policy.permitir_inativo_vencido',
  'policy.aceita_averbacao_como_destinatario',
  'policy.lmi',
  'policy.vigencia_inicio',
  'policy.vigencia_fim'
]);

const DIRECT_DOCUMENT_KEYS = new Set([
  'document.tipo',
  'document.valor_carga',
  'document.data_emissao',
  'document.tp_amb',
  'document.funcao_cnpj_segurado'
]);

const SPECIAL_INTERACTIVE_KEYS = new Set([
  'policy.suspensao',
  'titularity.allowed_functions',
  'sublimit.tipo_condicao',
  'sublimit.valor',
  'coverage.obrigatoria',
  'coverage.aplicar_todos_clientes',
  'coverage.ramo',
  'coverage.tipo_valor',
  'coverage.valor',
  'ingestion.channel'
]);

function isBusinessSetting(flag: TestLabFlagDefinition): boolean {
  return flag.source.kind === 'BUSINESS_SETTING' && flag.engine_status === 'ACTIVE';
}

function isInteractive(flag: TestLabFlagDefinition): boolean {
  if (flag.engine_status === 'PLANNED') return false;
  return (
    DIRECT_POLICY_KEYS.has(flag.key) ||
    DIRECT_DOCUMENT_KEYS.has(flag.key) ||
    SPECIAL_INTERACTIVE_KEYS.has(flag.key) ||
    isBusinessSetting(flag)
  );
}

function customOptions(flag: TestLabFlagDefinition) {
  if (flag.key === 'policy.suspensao') {
    return [
      { value: 'SEM_SUSPENSAO', label: 'Sem suspensão' },
      { value: 'SUSPENSA', label: 'Suspensa agora' },
      { value: 'SUSPENSAO_EXPIRADA', label: 'Suspensão já encerrada' }
    ];
  }
  if (flag.key === 'ingestion.channel') {
    return ['INTERNAL', 'API', 'PORTAL', 'SEFAZ', 'TMS', 'WHATSAPP'].map((value) => ({
      value,
      label: value
    }));
  }
  return undefined;
}

function controlFor(flag: TestLabFlagDefinition): TestLabStudioCapability['control'] {
  if (!isInteractive(flag)) return 'OFFICIAL_ONLY';
  if (flag.key === 'policy.suspensao') return 'ENUM';
  if (flag.value_type === 'BOOLEAN') return 'BOOLEAN';
  if (flag.value_type === 'ENUM') return 'ENUM';
  if (flag.value_type === 'NUMBER') return 'NUMBER';
  if (flag.value_type === 'DATE') return 'DATE';
  if (flag.value_type === 'MULTISELECT') return 'MULTISELECT';
  return 'STRING';
}

function defaultValues(flag: TestLabFlagDefinition): ScenarioDimensionValue[] {
  const custom = customOptions(flag);
  if (custom?.length) return [custom[0]!.value];
  const values = TestLabScenarioGenerator.valuesForFlag(flag);
  if (values.length === 0 || values[0] === null) {
    if (flag.value_type === 'BOOLEAN') return [false];
    if (flag.value_type === 'NUMBER') return [0];
    return [''];
  }
  if (flag.generation === 'NUMERIC_BOUNDARIES' && values.length >= 2) return [values[1]!];
  if (flag.generation === 'DATE_BOUNDARIES' && values.length >= 2) return [values[1]!];
  return [values[0]!];
}

function expectEqual(key: string, expected: unknown, actual: unknown) {
  return {
    key,
    expected,
    actual,
    pass: JSON.stringify(expected) === JSON.stringify(actual)
  };
}

export class TestLabStudioService {
  private static assertSafeEnvironment() {
    for (const name of ['NODE_ENV', 'APP_ENV', 'ENVIRONMENT', 'DEPLOYMENT_ENV']) {
      const value = process.env[name]?.toLowerCase();
      if (
        value &&
        !['test', 'teste', 'development', 'dev', 'local', 'staging', 'homologacao', 'homologation'].includes(value)
      ) {
        throw new Error('TEST_LAB_PRODUCTION_BLOCKED');
      }
    }
  }

  static capabilities() {
    const catalog = getTestLabCatalog();
    const capabilities: TestLabStudioCapability[] = catalog.flags.map((flag) => {
      const interactive = isInteractive(flag);
      return {
        key: flag.key,
        label: flag.label,
        group: flag.group,
        description: flag.description,
        engine_status: flag.engine_status,
        value_type: flag.value_type,
        generation: flag.generation,
        interactive,
        control: controlFor(flag),
        options:
          customOptions(flag) ??
          flag.options?.map((option) => ({
            value: option.value,
            label: option.label
          })),
        suggested_values: interactive
          ? flag.suggested_values ?? TestLabScenarioGenerator.valuesForFlag(flag)
          : undefined,
        reason: interactive
          ? undefined
          : flag.engine_status === 'PLANNED'
            ? 'Regra planejada: permanece GAP até existir efeito verificável no motor.'
            : 'Invariante/fluxo complexo coberto pela regressão oficial; não é parametrizado como campo livre.'
      };
    });

    return {
      version: 'studio-v2',
      max_cases: 250,
      default_reference_date: '2026-09-29T12:00:00.000-03:00',
      capabilities,
      interactive_count: capabilities.filter((item) => item.interactive).length,
      official_only_count: capabilities.filter((item) => !item.interactive).length
    };
  }

  private static normalizeRequest(request: TestLabStudioRequest) {
    const referenceDate = request.reference_date ?? '2026-09-29T12:00:00.000-03:00';
    if (!Number.isFinite(Date.parse(referenceDate))) {
      throw new Error('TEST_LAB_STUDIO_INVALID_REFERENCE_DATE');
    }

    const strategy = request.strategy ?? 'PAIRWISE';
    const maxCases = Math.max(1, Math.min(Number(request.max_cases ?? 100), 250));
    const catalog = getTestLabCatalog();
    const flagMap = new Map(catalog.flags.map((flag) => [flag.key, flag]));
    const seen = new Set<string>();

    if ((request.dimensions ?? []).length > 30) {
      throw new Error('TEST_LAB_STUDIO_TOO_MANY_DIMENSIONS');
    }

    const dimensions: ScenarioDimension[] = (request.dimensions ?? []).map((dimension) => {
      const flag = flagMap.get(dimension.key);
      if (!flag) throw new Error('TEST_LAB_STUDIO_UNKNOWN_FLAG:' + dimension.key);
      if (!isInteractive(flag)) throw new Error('TEST_LAB_STUDIO_FLAG_OFFICIAL_ONLY:' + dimension.key);
      if (seen.has(dimension.key)) throw new Error('TEST_LAB_STUDIO_DUPLICATE_DIMENSION:' + dimension.key);
      seen.add(dimension.key);
      const values = (dimension.values ?? []).filter(
        (value): value is ScenarioDimensionValue =>
          value === null || ['string', 'number', 'boolean'].includes(typeof value)
      );
      if (!values.length) throw new Error('TEST_LAB_STUDIO_EMPTY_DIMENSION:' + dimension.key);
      if (values.length > 25) throw new Error('TEST_LAB_STUDIO_TOO_MANY_VALUES:' + dimension.key);
      return { key: dimension.key, values };
    });

    if (!dimensions.length) {
      for (const key of ['policy.status', 'document.tipo', 'document.valor_carga']) {
        const flag = flagMap.get(key)!;
        dimensions.push({ key, values: defaultValues(flag) });
      }
    }

    return {
      referenceDate,
      strategy,
      maxCases,
      dimensions,
      fixture: request.fixture ?? {},
      expectation: request.expectation ?? {},
      name: request.name?.trim() || 'Cenário interativo'
    };
  }

  static preview(request: TestLabStudioRequest) {
    const normalized = this.normalizeRequest(request);
    const cartesianEstimate = TestLabScenarioGenerator.estimateCartesian(normalized.dimensions);
    let assignments: ScenarioAssignment[];

    if (normalized.strategy === 'SINGLE') {
      assignments = [
        Object.fromEntries(normalized.dimensions.map((dimension) => [dimension.key, dimension.values[0]!]))
      ];
    } else if (normalized.strategy === 'CARTESIAN') {
      assignments = TestLabScenarioGenerator.cartesian(normalized.dimensions, normalized.maxCases);
    } else {
      assignments = TestLabScenarioGenerator.pairwise(normalized.dimensions);
      if (assignments.length > normalized.maxCases) {
        throw new Error('TEST_LAB_STUDIO_MATRIX_LIMIT');
      }
    }

    return {
      name: normalized.name,
      strategy: normalized.strategy,
      reference_date: normalized.referenceDate,
      cartesian_estimate: cartesianEstimate,
      cases: assignments.length,
      dimensions: normalized.dimensions,
      preview: assignments.slice(0, 50),
      truncated_preview: assignments.length > 50
    };
  }

  static async execute(request: TestLabStudioRequest) {
    this.assertSafeEnvironment();
    const normalized = this.normalizeRequest(request);
    const preview = this.preview(request);
    const assignments = preview.preview.length === preview.cases
      ? preview.preview
      : normalized.strategy === 'CARTESIAN'
        ? TestLabScenarioGenerator.cartesian(normalized.dimensions, normalized.maxCases)
        : normalized.strategy === 'SINGLE'
          ? [Object.fromEntries(normalized.dimensions.map((dimension) => [dimension.key, dimension.values[0]!]))]
          : TestLabScenarioGenerator.pairwise(normalized.dimensions);

    if (assignments.length > normalized.maxCases) throw new Error('TEST_LAB_STUDIO_MATRIX_LIMIT');

    const startedAt = Date.now();
    const results: TestLabStudioCaseResult[] = [];
    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index]!;
      const result = await dbStore.runTestLabEphemeral(() =>
        withClock(Date.parse(normalized.referenceDate), () =>
          this.executeCase(index, assignment, normalized.fixture, normalized.expectation, normalized.referenceDate)
        )
      );
      results.push(result);
    }

    return {
      id: 'STUDIO-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + uuidv4().slice(0, 8),
      name: normalized.name,
      strategy: normalized.strategy,
      reference_date: normalized.referenceDate,
      cases: results.length,
      passed: results.filter((result) => result.status === 'PASS').length,
      failed: results.filter((result) => result.status === 'FAIL').length,
      unvalidated: results.filter((result) => result.status === 'UNVALIDATED').length,
      duration_ms: Date.now() - startedAt,
      results
    };
  }

  private static setupBase(
    assignment: ScenarioAssignment,
    fixture: TestLabStudioFixture,
    referenceDate: string
  ) {
    const nowIso = referenceDate;
    const ramo = fixture.ramo ?? 'RCTRC';

    dbStore.tenants = [
      {
        id: TENANT_ID,
        cnpj: '12345678000190',
        razao_social: 'TRANSPORTADORA LAB STUDIO',
        nome_fantasia: 'LAB STUDIO',
        status: 'ATIVO',
        ambiente: 'teste',
        client_id: 'studio-client',
        client_secret_hash: 'studio-secret',
        role: 'TRANSPORTADOR',
        token_duration_hours: 8,
        created_at: nowIso
      }
    ];

    dbStore.insurers = [
      {
        id: INSURER_A_ID,
        cnpj: '11111111000191',
        nome: 'SEGURADORA A STUDIO',
        razao_social: 'SEGURADORA A STUDIO',
        nome_fantasia: 'SEG A STUDIO',
        created_at: nowIso
      },
      {
        id: INSURER_B_ID,
        cnpj: '22222222000192',
        nome: 'SEGURADORA B STUDIO',
        razao_social: 'SEGURADORA B STUDIO',
        nome_fantasia: 'SEG B STUDIO',
        created_at: nowIso
      }
    ];

    dbStore.brokers = [
      {
        id: BROKER_ID,
        cnpj: '33333333000193',
        nome: 'CORRETORA LAB STUDIO',
        razao_social: 'CORRETORA LAB STUDIO',
        partner_type: 'CORRETORA',
        created_at: nowIso
      }
    ];

    const referenceMs = Date.parse(referenceDate);
    const primary: Policy = {
      id: PRIMARY_POLICY_ID,
      numero_apolice: 'STUDIO-A-RCTRC-001',
      ramo,
      tenant_id: TENANT_ID,
      insurer_id: INSURER_A_ID,
      broker_id: BROKER_ID,
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: new Date(referenceMs - 30 * 86400000).toISOString(),
      vigencia_fim: new Date(referenceMs + 365 * 86400000).toISOString(),
      lmi: 100000,
      aceita_averbacao_como_destinatario: false
    };

    if (assignment['policy.status'] !== undefined) primary.status = assignment['policy.status'] as Policy['status'];
    if (assignment['policy.permitir_inativo_vencido'] !== undefined) {
      primary.permitir_inativo_vencido = Boolean(assignment['policy.permitir_inativo_vencido']);
    }
    if (assignment['policy.aceita_averbacao_como_destinatario'] !== undefined) {
      primary.aceita_averbacao_como_destinatario = Boolean(
        assignment['policy.aceita_averbacao_como_destinatario']
      );
    }
    if (assignment['policy.lmi'] !== undefined) primary.lmi = Number(assignment['policy.lmi']);
    if (assignment['policy.vigencia_inicio']) primary.vigencia_inicio = String(assignment['policy.vigencia_inicio']);
    if (assignment['policy.vigencia_fim']) primary.vigencia_fim = String(assignment['policy.vigencia_fim']);

    const suspension = assignment['policy.suspensao'];
    if (suspension === 'SUSPENSA') {
      primary.suspensa_desde = new Date(referenceMs - 3600000).toISOString();
      primary.suspensa_ate = new Date(referenceMs + 3600000).toISOString();
    } else if (suspension === 'SUSPENSAO_EXPIRADA') {
      primary.suspensa_desde = new Date(referenceMs - 7200000).toISOString();
      primary.suspensa_ate = new Date(referenceMs - 3600000).toISOString();
    }

    const keepAlive: Policy = {
      ...primary,
      id: 'lab-studio-policy-keepalive',
      numero_apolice: 'STUDIO-KEEPALIVE-RCV',
      ramo: 'RCV',
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: new Date(referenceMs - 30 * 86400000).toISOString(),
      vigencia_fim: new Date(referenceMs + 365 * 86400000).toISOString(),
      suspensa_desde: undefined,
      suspensa_ate: undefined
    };

    const policies: Policy[] = [primary, keepAlive];
    if (fixture.secondary_policy?.enabled) {
      policies.push({
        ...primary,
        id: SECONDARY_POLICY_ID,
        numero_apolice: 'STUDIO-B-RCTRC-002',
        insurer_id: INSURER_B_ID,
        status: fixture.secondary_policy.status ?? 'ATIVA',
        vigencia_inicio:
          fixture.secondary_policy.vigencia_inicio ??
          new Date(referenceMs - 30 * 86400000).toISOString(),
        vigencia_fim:
          fixture.secondary_policy.vigencia_fim ??
          new Date(referenceMs + 365 * 86400000).toISOString(),
        lmi: fixture.secondary_policy.lmi ?? primary.lmi,
        suspensa_desde: undefined,
        suspensa_ate: undefined
      });
    }

    dbStore.policies = policies;
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

    const businessConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(assignment)) {
      const flag = getTestLabCatalog().flags.find((item) => item.key === key);
      if (flag?.source.kind === 'BUSINESS_SETTING') businessConfig[key] = value;
    }
    if (Object.keys(businessConfig).length) {
      dbStore.policyBusinessSettings = [
        {
          id: 'studio-settings-primary',
          policy_id: PRIMARY_POLICY_ID,
          config: businessConfig,
          updated_at: nowIso
        }
      ];
    }

    const titularity = assignment['titularity.allowed_functions'];
    if (typeof titularity === 'string' && titularity) {
      dbStore.policyTitularityRules = [
        {
          id: 'studio-titularity',
          policy_id: PRIMARY_POLICY_ID,
          funcao: titularity as FuncaoDocumento,
          habilitada: true
        }
      ];
    }

    const sublimitType = assignment['sublimit.tipo_condicao'] as TipoCondicaoSublimite | undefined;
    const sublimitValue = assignment['sublimit.valor'];
    if (sublimitType || sublimitValue !== undefined) {
      const type = sublimitType ?? 'mercadoria';
      dbStore.policySublimites = [
        {
          id: 'studio-sublimit',
          policy_id: PRIMARY_POLICY_ID,
          tipo_condicao: type,
          tag: type === 'tomador' ? undefined : fixture.produto_predominante ?? 'Carga Geral Embalada',
          cnpj_tomador: type === 'mercadoria' ? undefined : '98765432000188',
          valor: String(sublimitValue ?? 50000),
          created_at: nowIso
        }
      ];
    }

    const hasCoverageDimension = Object.keys(assignment).some((key) => key.startsWith('coverage.'));
    if (hasCoverageDimension) {
      const coverageTitle = 'COBERTURA_STUDIO';
      const aplicarTodos = assignment['coverage.aplicar_todos_clientes'] !== false;
      dbStore.insurerCoverages = [
        {
          id: 'studio-coverage',
          insurer_id: INSURER_A_ID,
          ramo: (assignment['coverage.ramo'] as RamoApolice | undefined) ?? ramo,
          titulo: coverageTitle,
          obrigatoria: Boolean(assignment['coverage.obrigatoria']),
          aplicar_todos_clientes: aplicarTodos,
          tenant_id: aplicarTodos ? undefined : TENANT_ID,
          tipo_valor: (assignment['coverage.tipo_valor'] as 'monetario' | 'informativo' | undefined) ?? 'monetario',
          created_at: nowIso
        }
      ];
      dbStore.policyCoverageValues = [
        {
          id: 'studio-policy-coverage',
          policy_id: PRIMARY_POLICY_ID,
          insurer_coverage_id: 'studio-coverage',
          valor: Number(assignment['coverage.valor'] ?? 0),
          desconta_lmi: false,
          created_at: nowIso,
          updated_at: nowIso
        }
      ];
    }

    return { primary, policies };
  }

  private static async executeCase(
    index: number,
    assignment: ScenarioAssignment,
    fixture: TestLabStudioFixture,
    expectation: TestLabStudioExpectation,
    referenceDate: string
  ): Promise<TestLabStudioCaseResult> {
    const started = Date.now();
    const { primary } = this.setupBase(assignment, fixture, referenceDate);
    const tipoDoc = (assignment['document.tipo'] as TipoDocumento | undefined) ?? 'CTE';
    const valorCarga = Number(assignment['document.valor_carga'] ?? 1000);
    const tpAmb = Number(assignment['document.tp_amb'] ?? 2) === 1 ? 1 : 2;
    const funcaoValue = assignment['document.funcao_cnpj_segurado'];
    const omitirCnpjTenant = funcaoValue === 'AUSENTE';
    const funcaoTenant =
      !omitirCnpjTenant && typeof funcaoValue === 'string'
        ? (funcaoValue as FuncaoDocumento)
        : 'EMISSOR';
    const source =
      (assignment['ingestion.channel'] as DocumentIngestionSource | undefined) ?? 'INTERNAL';

    const businessFlags = Object.keys(assignment).filter((key) => key.startsWith('regras:') || key.startsWith('recusas:'));
    const autoObservation: string[] = [];
    if (assignment['regras:placa'] === true) autoObservation.push('PLACA=ABC1D23');
    if (assignment['regras:motorista'] === true) autoObservation.push('MOTORISTA=12345678901');
    if (assignment['regras:embarque'] === true) autoObservation.push('DATA_EMBARQUE=29/09/2026');
    if (fixture.include_coverage_in_document && Object.keys(assignment).some((key) => key.startsWith('coverage.'))) {
      autoObservation.push('COBERTURA_STUDIO=' + String(assignment['coverage.valor'] ?? 100));
    }

    const observation =
      fixture.observation_text !== undefined
        ? fixture.observation_text
        : autoObservation.length
          ? autoObservation.join('; ')
          : businessFlags.length
            ? 'STUDIO=1'
            : undefined;

    const xml = new TestLabFixtureGenerator(
      'arckatech-studio-v2',
      referenceDate
    ).xml(
      {
        tenantId: TENANT_ID,
        tipoDoc,
        policyId: PRIMARY_POLICY_ID,
        documentNumber: 680000 + index,
        valorCarga,
        emissionDate:
          typeof assignment['document.data_emissao'] === 'string'
            ? String(assignment['document.data_emissao'])
            : referenceDate,
        tpAmbSefaz: tpAmb,
        funcaoTenant,
        omitirCnpjTenant,
        ufOrigem: fixture.uf_origem,
        ufDestino: fixture.uf_destino,
        produtoPredominante: fixture.produto_predominante,
        observationOverride: observation
      },
      'case-' + index + '-' + JSON.stringify(assignment)
    );

    const response = DocumentIngestionService.processXml({
      tenant_id: TENANT_ID,
      ramo: fixture.ramo ?? 'RCTRC',
      ...(fixture.matching_mode === 'AUTO' ? {} : { policy_id: PRIMARY_POLICY_ID }),
      xml_content: xml,
      source,
      supplemented_vars: fixture.supplemented_vars as Record<string, any> | undefined,
      app_base_url: 'http://localhost:5173'
    });

    const record = response.averbacao_id
      ? dbStore.averbacoes.find((item) => item.id === response.averbacao_id)
      : undefined;
    const matchedPolicy =
      record?.policy_id === PRIMARY_POLICY_ID
        ? 'PRIMARY'
        : record?.policy_id === SECONDARY_POLICY_ID
          ? 'SECONDARY'
          : record?.policy_id
            ? 'UNKNOWN'
            : undefined;

    const assertions = [];
    if (expectation.status) assertions.push(expectEqual('status', expectation.status, response.status));
    if (expectation.codigo) assertions.push(expectEqual('codigo', expectation.codigo, response.codigo));
    if (expectation.matched_policy) {
      assertions.push(expectEqual('matched_policy', expectation.matched_policy, matchedPolicy));
    }

    // Sem expectativa explícita, o Studio continua útil como explorador e considera a execução
    // tecnicamente concluída. Quando o usuário informa esperado, PASS/FAIL passa a comparar.
    const passed = assertions.length === 0 || assertions.every((item) => item.pass);

    return {
      index,
      assignment,
      status: assertions.length === 0 ? 'UNVALIDATED' : passed ? 'PASS' : 'FAIL',
      duration_ms: Date.now() - started,
      expected: expectation,
      actual: {
        status: response.status,
        codigo: response.codigo,
        matched_policy: matchedPolicy,
        policy_id: record?.policy_id,
        mensagem: response.mensagem,
        valor_considerado_averbacao: response.valor_considerado_averbacao,
        regras_internas_aplicadas: response.regras_internas_aplicadas,
        variaveis_faltantes: response.variaveis_faltantes
      },
      assertions
    };
  }
}
