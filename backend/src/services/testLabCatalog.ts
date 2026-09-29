/**
 * Catálogo declarativo do Laboratório de Testes.
 *
 * Regra de desenho:
 * - a interface NÃO conhece flags específicas;
 * - qualquer nova regra/flag entra neste catálogo;
 * - o runner e a UI consomem os mesmos metadados;
 * - itens PLANNED ficam visíveis para evitar que configuração de UI pareça coberta pelo motor.
 *
 * Nesta primeira fase o catálogo é somente leitura. As próximas fases usam `generation`
 * para montar cenários automaticamente e `assertions` para validar o resultado.
 */

export type TestLabValueType =
  | 'BOOLEAN'
  | 'ENUM'
  | 'NUMBER'
  | 'STRING'
  | 'DATE'
  | 'MULTISELECT'
  | 'INVARIANT';

export type TestLabEngineStatus = 'ACTIVE' | 'PLANNED' | 'INVARIANT';

export type TestLabSourceKind =
  | 'POLICY_FIELD'
  | 'BUSINESS_SETTING'
  | 'SUBLIMIT'
  | 'COVERAGE'
  | 'DOCUMENT'
  | 'INGESTION'
  | 'ACCESS';

export type TestLabGenerationStrategy =
  | 'BOOLEAN_BOTH'
  | 'ENUM_ALL'
  | 'NUMERIC_BOUNDARIES'
  | 'DATE_BOUNDARIES'
  | 'PAIRWISE'
  | 'INVARIANT_MATRIX'
  | 'MANUAL_ONLY';

export interface TestLabOption {
  value: string | number | boolean;
  label: string;
}

export interface TestLabFlagDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  source: {
    kind: TestLabSourceKind;
    path: string;
  };
  value_type: TestLabValueType;
  engine_status: TestLabEngineStatus;
  generation: TestLabGenerationStrategy;
  options?: TestLabOption[];
  suggested_values?: Array<string | number | boolean>;
  depends_on?: string[];
  tags: string[];
}

export interface TestLabGroupDefinition {
  key: string;
  label: string;
  description: string;
  order: number;
}

export interface TestLabSuiteTemplate {
  key: string;
  label: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  flag_keys: string[];
}

const groups: TestLabGroupDefinition[] = [
  {
    key: 'policy',
    label: 'Apólice e vigência',
    description: 'Estado administrativo, vigência, suspensão, LMI e exceções estruturais da apólice.',
    order: 10
  },
  {
    key: 'required-data',
    label: 'Dados obrigatórios',
    description: 'Flags que exigem informações adicionais do veículo, motorista ou embarque.',
    order: 20
  },
  {
    key: 'limits',
    label: 'Limites, sublimites e recusas',
    description: 'LMI, sublimites, estratégias de excedente, fila de aprovação e códigos de liberação.',
    order: 30
  },
  {
    key: 'deadlines',
    label: 'Prazos e datas',
    description: 'Regras temporais de emissão, embarque, cancelamento e vigência.',
    order: 40
  },
  {
    key: 'documents',
    label: 'Documentos fiscais',
    description: 'Tipos de DF-e, autorização SEFAZ, ambiente e papel do CNPJ no documento.',
    order: 50
  },
  {
    key: 'coverage',
    label: 'Coberturas',
    description: 'Coberturas adicionais e sua interação com o valor considerado na averbação.',
    order: 60
  },
  {
    key: 'ingestion',
    label: 'Canais e idempotência',
    description: 'Portal, TMS, Connector, OUTBOUND, SEFAZ e WhatsApp usando o mesmo pipeline.',
    order: 70
  },
  {
    key: 'access',
    label: 'Segurança e visibilidade',
    description: 'Isolamento por seguradora, apólice, segurado e demais atores autenticados.',
    order: 80
  },
  {
    key: 'future',
    label: 'Configurações ainda não aplicadas pelo motor',
    description: 'Itens já existentes na interface/dados, mas que não podem ser marcados como validados enquanto o motor não os consumir.',
    order: 90
  }
];

const flags: TestLabFlagDefinition[] = [
  {
    key: 'policy.status',
    group: 'policy',
    label: 'Status da apólice',
    description: 'Valida comportamento para apólice ativa, inativa ou vencida.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.status' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'ATIVA', label: 'Ativa' },
      { value: 'INATIVA', label: 'Inativa' },
      { value: 'VENCIDA', label: 'Vencida' }
    ],
    tags: ['policy', 'status', 'p0']
  },
  {
    key: 'policy.permitir_inativo_vencido',
    group: 'policy',
    label: 'Permitir inativo/vencido',
    description: 'Bypass configurável para cadastro/apólice em condição não regular.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.permitir_inativo_vencido' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['policy', 'bypass', 'p0']
  },
  {
    key: 'policy.aceita_averbacao_como_destinatario',
    group: 'policy',
    label: 'Aceita averbação como destinatário',
    description: 'Valida o papel do CNPJ segurado no documento quando não é o emitente.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.aceita_averbacao_como_destinatario' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['policy', 'cnpj-role', 'p0']
  },
  {
    key: 'policy.lmi',
    group: 'limits',
    label: 'LMI',
    description: 'Gera valores abaixo, iguais e acima do limite máximo da apólice.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.lmi' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    suggested_values: [0, 100000],
    tags: ['limit', 'lmi', 'boundary', 'p0']
  },
  {
    key: 'policy.vigencia_inicio',
    group: 'deadlines',
    label: 'Início da vigência',
    description: 'Testa documento antes, dentro e no limite inicial de vigência.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.vigencia_inicio' },
    value_type: 'DATE',
    engine_status: 'ACTIVE',
    generation: 'DATE_BOUNDARIES',
    tags: ['date', 'validity', 'p0']
  },
  {
    key: 'policy.vigencia_fim',
    group: 'deadlines',
    label: 'Fim da vigência',
    description: 'Testa documento antes, exatamente no limite e após o fim da vigência.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.vigencia_fim' },
    value_type: 'DATE',
    engine_status: 'ACTIVE',
    generation: 'DATE_BOUNDARIES',
    tags: ['date', 'validity', 'p0']
  },
  {
    key: 'policy.suspensao',
    group: 'policy',
    label: 'Suspensão da apólice',
    description: 'Valida suspensão atual, futura, determinada e indeterminada.',
    source: { kind: 'POLICY_FIELD', path: 'Policy.suspensa_desde/Policy.suspensa_ate' },
    value_type: 'INVARIANT',
    engine_status: 'ACTIVE',
    generation: 'INVARIANT_MATRIX',
    tags: ['policy', 'suspension', 'p0']
  },
  {
    key: 'regras:placa',
    group: 'required-data',
    label: 'Placa obrigatória',
    description: 'Quando ativa, o motor exige placa do veículo nas variáveis disponíveis.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:placa"]' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['required-field', 'vehicle']
  },
  {
    key: 'regras:motorista',
    group: 'required-data',
    label: 'Motorista obrigatório',
    description: 'Quando ativa, o motor exige identificação do motorista.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:motorista"]' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['required-field', 'driver']
  },
  {
    key: 'regras:embarque',
    group: 'required-data',
    label: 'Data de embarque obrigatória',
    description: 'Quando ativa, exige a variável/data de embarque usada pelo motor.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:embarque"]' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['required-field', 'shipment-date']
  },
  {
    key: 'regras:documentos-aceitos',
    group: 'documents',
    label: 'Tipos de documento aceitos',
    description: 'Define quais documentos podem selecionar automaticamente a apólice.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:documentos-aceitos"]' },
    value_type: 'MULTISELECT',
    engine_status: 'ACTIVE',
    generation: 'PAIRWISE',
    options: [
      { value: 'CT-e', label: 'CT-e' },
      { value: 'NF-e', label: 'NF-e' },
      { value: 'MDF-e', label: 'MDF-e' },
      { value: 'NFS-e', label: 'NFS-e' }
    ],
    tags: ['document', 'matching', 'p0']
  },
  {
    key: 'regras:estrategia-lmg',
    group: 'limits',
    label: 'Estratégia de limite',
    description: 'Estratégia aplicada pelo motor quando LMI/sublimite é excedido.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:estrategia-lmg"]' },
    value_type: 'STRING',
    engine_status: 'ACTIVE',
    generation: 'PAIRWISE',
    tags: ['limit', 'strategy', 'p0']
  },
  {
    key: 'regras:sem-codigo-modo',
    group: 'limits',
    label: 'Comportamento sem código de liberação',
    description: 'Controla o destino do excedente quando não há código de liberação informado.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:sem-codigo-modo"]' },
    value_type: 'STRING',
    engine_status: 'ACTIVE',
    generation: 'PAIRWISE',
    tags: ['limit', 'release-code']
  },
  {
    key: 'regras:teto-acima-acao',
    group: 'limits',
    label: 'Ação acima do teto',
    description: 'Define a ação tomada quando o valor ultrapassa o teto configurado.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:teto-acima-acao"]' },
    value_type: 'STRING',
    engine_status: 'ACTIVE',
    generation: 'PAIRWISE',
    tags: ['limit', 'threshold']
  },
  {
    key: 'regras:teto-valor',
    group: 'limits',
    label: 'Valor do teto',
    description: 'Valor de referência usado pela estratégia de tratamento de excedente.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:teto-valor"]' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    tags: ['limit', 'threshold', 'boundary']
  },
  {
    key: 'regras:fila-aprovacao-recusas',
    group: 'limits',
    label: 'Fila de aprovação para recusas',
    description: 'Quando habilitada, determinados erros viram pendências para análise em vez de recusa definitiva.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:fila-aprovacao-recusas"]' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['pending', 'approval', 'p0']
  },
  {
    key: 'regras:prazo-valor',
    group: 'deadlines',
    label: 'Prazo de emissão - valor',
    description: 'Valor numérico usado na regra de prazo configurada para a apólice.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:prazo-valor"]' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    tags: ['deadline', 'issuance']
  },
  {
    key: 'regras:prazo-unidade',
    group: 'deadlines',
    label: 'Prazo de emissão - unidade',
    description: 'Unidade temporal usada junto ao valor do prazo.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:prazo-unidade"]' },
    value_type: 'STRING',
    engine_status: 'ACTIVE',
    generation: 'PAIRWISE',
    tags: ['deadline', 'issuance']
  },
  {
    key: 'regras:prazo-campo',
    group: 'deadlines',
    label: 'Campo-base do prazo',
    description: 'Campo/data do documento usado como referência no cálculo temporal.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:prazo-campo"]' },
    value_type: 'STRING',
    engine_status: 'ACTIVE',
    generation: 'PAIRWISE',
    tags: ['deadline', 'document-field']
  },
  {
    key: 'regras:dias-apos',
    group: 'deadlines',
    label: 'Dias após emissão',
    description: 'Janela adicional aplicada na validação temporal.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:dias-apos"]' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    tags: ['deadline', 'boundary']
  },
  {
    key: 'regras:prazo-embarque',
    group: 'deadlines',
    label: 'Regra de prazo de embarque',
    description: 'Ativa/aplica a validação de prazo relacionada ao embarque.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:prazo-embarque"]' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['deadline', 'shipment']
  },
  {
    key: 'regras:prazo-cancelamento-valor',
    group: 'deadlines',
    label: 'Prazo de cancelamento',
    description: 'Janela disponível para cancelamento self-service pelo segurado.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:prazo-cancelamento-valor"]' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    tags: ['deadline', 'cancellation']
  },
  {
    key: 'regras:prazo-cancelamento-unidade',
    group: 'deadlines',
    label: 'Unidade do prazo de cancelamento',
    description: 'Horas ou dias usados pela janela de cancelamento self-service.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:prazo-cancelamento-unidade"]' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'Horas', label: 'Horas' },
      { value: 'Dias', label: 'Dias' },
      { value: 'Meses', label: 'Meses' }
    ],
    tags: ['deadline', 'cancellation']
  },
  {
    key: 'sublimit.tipo_condicao',
    group: 'limits',
    label: 'Tipo de sublimite',
    description: 'Testa precedência entre mercadoria, tomador e tomador + mercadoria.',
    source: { kind: 'SUBLIMIT', path: 'PolicySublimite.tipo_condicao' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'mercadoria', label: 'Mercadoria' },
      { value: 'tomador', label: 'Tomador' },
      { value: 'tomador_mercadoria', label: 'Tomador + mercadoria' }
    ],
    tags: ['sublimit', 'precedence', 'p0']
  },
  {
    key: 'sublimit.valor',
    group: 'limits',
    label: 'Valor do sublimite',
    description: 'Gera documento abaixo, igual e acima do sublimite selecionado.',
    source: { kind: 'SUBLIMIT', path: 'PolicySublimite.valor' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    depends_on: ['sublimit.tipo_condicao'],
    tags: ['sublimit', 'boundary', 'p0']
  },
  {
    key: 'document.tipo',
    group: 'documents',
    label: 'Tipo do documento',
    description: 'Executa cenários para CT-e, NF-e, MDF-e e NFS-e.',
    source: { kind: 'DOCUMENT', path: 'ParsedDocumentData.tipoDocumento' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'CTE', label: 'CT-e' },
      { value: 'NFE', label: 'NF-e' },
      { value: 'MDFE', label: 'MDF-e' },
      { value: 'NFSE', label: 'NFS-e' }
    ],
    tags: ['document', 'p0']
  },
  {
    key: 'document.valor_carga',
    group: 'documents',
    label: 'Valor da carga',
    description: 'Dimensão usada para cruzar limites, sublimites e coberturas.',
    source: { kind: 'DOCUMENT', path: 'ParsedDocumentData.valorCarga' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    tags: ['document', 'value', 'boundary', 'p0']
  },
  {
    key: 'document.tp_amb',
    group: 'documents',
    label: 'Ambiente SEFAZ',
    description: 'Valida produção (1) e homologação (2), incluindo prefixo de teste.',
    source: { kind: 'DOCUMENT', path: 'ParsedDocumentData.tpAmbSefaz' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 1, label: 'Produção' },
      { value: 2, label: 'Homologação' }
    ],
    tags: ['sefaz', 'environment', 'p0']
  },
  {
    key: 'document.autorizacao_sefaz',
    group: 'documents',
    label: 'Autorização SEFAZ',
    description: 'Combina protocolo e cStat para provar que captura OUTBOUND não averba documento sem autorização.',
    source: { kind: 'DOCUMENT', path: 'ParsedDocumentData.protocoloAceitacaoSefaz/cStatAutorizacaoSefaz' },
    value_type: 'INVARIANT',
    engine_status: 'ACTIVE',
    generation: 'INVARIANT_MATRIX',
    tags: ['sefaz', 'authorization', 'outbound', 'p0']
  },
  {
    key: 'document.funcao_cnpj_segurado',
    group: 'documents',
    label: 'Papel do CNPJ segurado',
    description: 'Emissor, destinatário, remetente, tomador, expedidor, recebedor ou ausente.',
    source: { kind: 'DOCUMENT', path: 'MockGenerationOptions.funcaoTenant' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'EMISSOR', label: 'Emitente' },
      { value: 'DESTINATARIO', label: 'Destinatário' },
      { value: 'REMETENTE', label: 'Remetente' },
      { value: 'TOMADOR', label: 'Tomador' },
      { value: 'EXPEDIDOR', label: 'Expedidor' },
      { value: 'RECEBEDOR', label: 'Recebedor' },
      { value: 'AUSENTE', label: 'Não aparece no documento' }
    ],
    tags: ['cnpj', 'document-role', 'p0']
  },
  {
    key: 'coverage.valor',
    group: 'coverage',
    label: 'Valor de cobertura adicional',
    description: 'Valida soma monetária ao valor considerado antes dos limites.',
    source: { kind: 'COVERAGE', path: 'PolicyCoverageValue.valor' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    tags: ['coverage', 'value', 'lmi']
  },
  {
    key: 'coverage.desconta_lmi',
    group: 'future',
    label: 'Cobertura desconta do LMI',
    description: 'A interface armazena esta flag, mas o próprio portal informa que o desconto do LMI ainda não é aplicado pelo motor.',
    source: { kind: 'COVERAGE', path: 'PolicyCoverageValue.desconta_lmi' },
    value_type: 'BOOLEAN',
    engine_status: 'PLANNED',
    generation: 'BOOLEAN_BOTH',
    tags: ['coverage', 'lmi', 'gap']
  },
  {
    key: 'regras:averbacao-esporadica-on',
    group: 'future',
    label: 'Averbação esporádica',
    description: 'Configuração existente na interface; ainda não localizada como regra consumida pelo motor atual.',
    source: { kind: 'BUSINESS_SETTING', path: 'PolicyBusinessSettings.config["regras:averbacao-esporadica-on"]' },
    value_type: 'BOOLEAN',
    engine_status: 'PLANNED',
    generation: 'BOOLEAN_BOTH',
    tags: ['sporadic', 'gap']
  },
  {
    key: 'ingestion.channel',
    group: 'ingestion',
    label: 'Canal de entrada',
    description: 'O mesmo documento deve manter comportamento de negócio consistente em todos os canais suportados.',
    source: { kind: 'INGESTION', path: 'FiscalDocument.source' },
    value_type: 'ENUM',
    engine_status: 'INVARIANT',
    generation: 'ENUM_ALL',
    options: [
      { value: 'PORTAL', label: 'Portal' },
      { value: 'TMS', label: 'TMS/API' },
      { value: 'SEFAZ', label: 'Connector/SEFAZ' },
      { value: 'WHATSAPP', label: 'WhatsApp Adapter' }
    ],
    tags: ['ingestion', 'multichannel', 'p0']
  },
  {
    key: 'ingestion.deduplication',
    group: 'ingestion',
    label: 'Deduplicação multicanal',
    description: 'Um mesmo DF-e recebido por canais diferentes deve criar no máximo uma averbação efetiva.',
    source: { kind: 'INGESTION', path: 'DocumentIngestionService.prepareFiscalDocument' },
    value_type: 'INVARIANT',
    engine_status: 'INVARIANT',
    generation: 'INVARIANT_MATRIX',
    tags: ['idempotency', 'multichannel', 'p0']
  },
  {
    key: 'access.insurer_policy_isolation',
    group: 'access',
    label: 'Isolamento Seguradora → Apólice → Averbação',
    description: 'Seguradora A só pode visualizar/agregar averbações ligadas às apólices da própria Seguradora A, mesmo quando o segurado é compartilhado com outra seguradora.',
    source: { kind: 'ACCESS', path: 'session.insurer_id -> Policy.insurer_id -> Averbacao.policy_id' },
    value_type: 'INVARIANT',
    engine_status: 'INVARIANT',
    generation: 'INVARIANT_MATRIX',
    tags: ['rbac', 'tenant-isolation', 'insurer', 'p0', 'security']
  },
  {
    key: 'access.direct_object_reference',
    group: 'access',
    label: 'Bloqueio de acesso direto a recurso de outra seguradora',
    description: 'IDs conhecidos de apólice/averbação de outra seguradora não podem contornar o escopo da sessão.',
    source: { kind: 'ACCESS', path: 'admin/broker resource scoping' },
    value_type: 'INVARIANT',
    engine_status: 'INVARIANT',
    generation: 'INVARIANT_MATRIX',
    tags: ['idor', 'rbac', 'security', 'p0']
  },
  {
    key: 'access.aggregate_isolation',
    group: 'access',
    label: 'Isolamento de totais e relatórios',
    description: 'Dashboard, contagens, valores, pendências e exportações devem agregar apenas apólices visíveis ao ator.',
    source: { kind: 'ACCESS', path: 'dashboard/report aggregation' },
    value_type: 'INVARIANT',
    engine_status: 'INVARIANT',
    generation: 'INVARIANT_MATRIX',
    tags: ['rbac', 'aggregate', 'report', 'p0']
  },
  {
    key: 'access.same_tenant_same_branch_two_insurers',
    group: 'access',
    label: 'Mesmo segurado + mesmo ramo + duas seguradoras',
    description: 'Cenário crítico para impedir seleção da primeira apólice do ramo e vazamento de visibilidade entre seguradoras.',
    source: { kind: 'ACCESS', path: 'Policy matching + insurer scoping' },
    value_type: 'INVARIANT',
    engine_status: 'INVARIANT',
    generation: 'INVARIANT_MATRIX',
    tags: ['matching', 'rbac', 'same-branch', 'p0']
  }
];

const suites: TestLabSuiteTemplate[] = [
  {
    key: 'p0-policy-engine',
    label: 'P0 — Motor de apólice',
    description: 'Valida estados da apólice, vigência, limites, documentos e principais fronteiras.',
    priority: 'P0',
    tags: ['engine', 'policy'],
    flag_keys: [
      'policy.status',
      'policy.permitir_inativo_vencido',
      'policy.aceita_averbacao_como_destinatario',
      'policy.vigencia_inicio',
      'policy.vigencia_fim',
      'policy.suspensao',
      'document.funcao_cnpj_segurado'
    ]
  },
  {
    key: 'p0-access-isolation',
    label: 'P0 — Isolamento entre seguradoras',
    description: 'Monta segurado compartilhado e prova isolamento de objetos e agregações por apólice/seguradora.',
    priority: 'P0',
    tags: ['security', 'rbac'],
    flag_keys: [
      'access.insurer_policy_isolation',
      'access.direct_object_reference',
      'access.aggregate_isolation',
      'access.same_tenant_same_branch_two_insurers'
    ]
  },
  {
    key: 'p0-multichannel',
    label: 'P0 — Multicanal e idempotência',
    description: 'Reenvia o mesmo documento pelos canais suportados e garante resultado consistente sem duplicar averbação.',
    priority: 'P0',
    tags: ['ingestion', 'idempotency'],
    flag_keys: [
      'ingestion.channel',
      'ingestion.deduplication',
      'document.autorizacao_sefaz',
      'regras:documentos-aceitos',
      'document.tipo'
    ]
  },
  {
    key: 'p0-limits',
    label: 'P0 — LMI e sublimites',
    description: 'Cruza limites, estratégias, sublimites e valores de fronteira.',
    priority: 'P0',
    tags: ['limits'],
    flag_keys: [
      'policy.lmi',
      'regras:estrategia-lmg',
      'regras:sem-codigo-modo',
      'regras:teto-acima-acao',
      'regras:teto-valor',
      'regras:fila-aprovacao-recusas',
      'sublimit.tipo_condicao',
      'sublimit.valor',
      'document.valor_carga'
    ]
  }
,
  {
    key: 'p1-required-data',
    label: 'P1 — Dados obrigatórios e recuperação',
    description: 'Valida placa, motorista, embarque e preenchimento suplementar.',
    priority: 'P1',
    tags: ['required-data', 'recovery'],
    flag_keys: ['regras:placa', 'regras:motorista', 'regras:embarque']
  },
  {
    key: 'p1-deadlines',
    label: 'P1 — Prazos e cancelamento',
    description: 'Valida fronteiras de emissão, embarque e cancelamento self-service.',
    priority: 'P1',
    tags: ['deadline', 'cancellation'],
    flag_keys: [
      'regras:prazo-valor',
      'regras:prazo-unidade',
      'regras:prazo-campo',
      'regras:dias-apos',
      'regras:prazo-embarque',
      'regras:prazo-cancelamento-valor',
      'regras:prazo-cancelamento-unidade'
    ]
  },
  {
    key: 'p1-coverages',
    label: 'P1 — Coberturas adicionais',
    description: 'Valida obrigatoriedade, soma monetária e gaps conhecidos de cobertura.',
    priority: 'P1',
    tags: ['coverage'],
    flag_keys: ['coverage.valor', 'coverage.desconta_lmi']
  },
  {
    key: 'p1-sefaz-contract',
    label: 'P1 — Contrato SEFAZ/Connector',
    description: 'Valida distribuição mock, NSU, consumo indevido e OUTBOUND autorizado/não autorizado.',
    priority: 'P1',
    tags: ['sefaz', 'connector'],
    flag_keys: ['document.autorizacao_sefaz', 'document.tp_amb', 'ingestion.channel']
  },
  {
    key: 'p1-catalog-governance',
    label: 'P1 — Governança do catálogo',
    description: 'Detecta regra de negócio nova sem definição correspondente no Laboratório.',
    priority: 'P1',
    tags: ['catalog', 'ci'],
    flag_keys: []
  }
];


const portalUiContractFlags: TestLabFlagDefinition[] = [
  {
    key: 'recusas:estrategia-lmg',
    group: 'limits',
    label: 'UI — Estratégia de LMG',
    description: 'Chave persistida pelo Portal da Seguradora; normalizada para a estratégia canônica do motor.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Regras de Negócio -> recusas:estrategia-lmg' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'codigo', label: 'Exigir código' },
      { value: 'sem-codigo', label: 'Permitir sem código' },
      { value: 'sem-trava', label: 'Aceitar sem trava' },
      { value: 'limite-apolice', label: 'Averbar no limite' }
    ],
    tags: ['portal-contract', 'limits', 'p1']
  },
  {
    key: 'recusas:sem-codigo-modo',
    group: 'limits',
    label: 'UI — Modo sem código',
    description: 'Alias do Portal para o comportamento sem código de liberação.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Regras de Negócio -> recusas:sem-codigo-modo' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'fila-sempre', label: 'Fila sempre' },
      { value: 'teto', label: 'Teto de autoaprovação' }
    ],
    tags: ['portal-contract', 'limits', 'p1']
  },
  {
    key: 'recusas:teto-valor',
    group: 'limits',
    label: 'UI — Teto de autoaprovação',
    description: 'Valor monetário salvo pela UI e convertido para número pelo motor.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Regras de Negócio -> recusas:teto-valor' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    suggested_values: [1050],
    tags: ['portal-contract', 'limits', 'p1']
  },
  {
    key: 'recusas:teto-acima-acao',
    group: 'limits',
    label: 'UI — Ação acima do teto',
    description: 'Alias do Portal para recusar ou enviar à fila acima do teto.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Regras de Negócio -> recusas:teto-acima-acao' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'recusar', label: 'Recusar' },
      { value: 'fila', label: 'Fila' }
    ],
    tags: ['portal-contract', 'limits', 'p1']
  },
  {
    key: 'recusas:fila-aprovacao',
    group: 'limits',
    label: 'UI — Fila de aprovação',
    description: 'Toggle do Portal normalizado para regras:fila-aprovacao-recusas.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Regras de Negócio -> recusas:fila-aprovacao' },
    value_type: 'BOOLEAN',
    engine_status: 'ACTIVE',
    generation: 'BOOLEAN_BOTH',
    tags: ['portal-contract', 'approval', 'p1']
  },
  {
    key: 'regras:prazo-embarque-v2',
    group: 'deadlines',
    label: 'UI — Prazo de embarque v2',
    description: 'Chave atual do Portal, compatibilizada com regras:prazo-embarque no motor.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Prazos e Datas -> regras:prazo-embarque-v2' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'antes', label: 'Antes' },
      { value: 'dia', label: 'No dia' },
      { value: 'apos', label: 'Após' },
      { value: 'nunca', label: 'Nunca recusar por prazo' }
    ],
    tags: ['portal-contract', 'deadline', 'p1']
  },
  {
    key: 'regras:modo-canc',
    group: 'deadlines',
    label: 'UI — Modo de cancelamento',
    description: 'Define se a UI habilita prazo de cancelamento.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Prazos e Datas -> regras:modo-canc' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'sem', label: 'Sem prazo configurado' },
      { value: 'prazo', label: 'Prazo limite' }
    ],
    tags: ['portal-contract', 'cancellation', 'p1']
  },
  {
    key: 'regras:canc-valor',
    group: 'deadlines',
    label: 'UI — Valor do prazo de cancelamento',
    description: 'Valor salvo pelo Portal e normalizado para a chave canônica de cancelamento.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Prazos e Datas -> regras:canc-valor' },
    value_type: 'NUMBER',
    engine_status: 'ACTIVE',
    generation: 'NUMERIC_BOUNDARIES',
    suggested_values: [7],
    tags: ['portal-contract', 'cancellation', 'p1']
  },
  {
    key: 'regras:canc-unidade',
    group: 'deadlines',
    label: 'UI — Unidade do cancelamento',
    description: 'Dias ou meses configurados na interface para o prazo de cancelamento.',
    source: { kind: 'BUSINESS_SETTING', path: 'Portal Prazos e Datas -> regras:canc-unidade' },
    value_type: 'ENUM',
    engine_status: 'ACTIVE',
    generation: 'ENUM_ALL',
    options: [
      { value: 'Dias', label: 'Dias' },
      { value: 'Meses', label: 'Meses' }
    ],
    tags: ['portal-contract', 'cancellation', 'p1']
  },

  // Configurações visíveis/persistidas no Portal que ainda não são consumidas diretamente
  // pelo motor atual. Mantê-las no catálogo evita que pareçam cobertas quando não estão.
  ...[
    ['recusas:fila-lmg-prazo-valor', 'Prazo da fila de LMG — valor'],
    ['recusas:fila-lmg-prazo-unidade', 'Prazo da fila de LMG — unidade'],
    ['recusas:fila-prazo-valor', 'Prazo da fila genérica — valor'],
    ['recusas:fila-prazo-unidade', 'Prazo da fila genérica — unidade'],
    ['regras:metodos', 'Métodos de averbação'],
    ['regras:isencao', 'Isenção de subcontratação'],
    ['regras:susep', 'Região metropolitana SUSEP'],
    ['regras:origem-destino', 'Origem/destino metropolitano'],
    ['regras:regioes', 'Regiões customizadas'],
    ['regras:hierarquia', 'Hierarquia de regiões'],
    ['regras:sem-valor', 'Condições sem valor'],
    ['regras:excecoes', 'Exceções de prazo'],
    ['regras:regra-a', 'Estado local Regra A'],
    ['regras:regra-b', 'Estado local Regra B'],
    ['regras:funcoes-a', 'Funções locais da Regra A'],
    ['regras:regrab-condicoes', 'Condições locais da Regra B'],
    ['regras:regrab-restringir', 'Restrição local da Regra B'],
    ['regras:averbacao-esporadica-limite', 'Averbação esporádica — limite'],
    ['regras:averbacao-esporadica-prazo', 'Averbação esporádica — prazo'],
    ['rcv:documentos-aceitos', 'RC-V — documentos aceitos'],
    ['rcv:exigir-placa-embarque', 'RC-V — exigir placa no embarque'],
    ['rcv:exigir-tag', 'RC-V — exigir TAG'],
    ['rcv:exigir-tag-transporte', 'RC-V — exigir TAG por transporte'],
    ['rcv:janela-averbacao-valor', 'RC-V — janela de averbação'],
    ['rcv:janela-averbacao-unidade', 'RC-V — unidade da janela de averbação'],
    ['rcv:janela-emissao-valor', 'RC-V — janela de emissão'],
    ['rcv:janela-emissao-unidade', 'RC-V — unidade da janela de emissão'],
    ['rcv:janela-placa-valor', 'RC-V — janela de placa'],
    ['rcv:janela-placa-unidade', 'RC-V — unidade da janela de placa'],
    ['rcv:replicacao-automatica', 'RC-V — replicação automática'],
    ['rcv:transporte-aceitos', 'RC-V — transportes aceitos'],
    ['rcv:faturamento:modelo', 'RC-V — modelo de faturamento'],
    ['rcv:faturamento:taxa-unica', 'RC-V — taxa única'],
    ['rcv:faturamento:faixas-km', 'RC-V — faixas de km'],
    ['rcv:faturamento:km-linear', 'RC-V — km linear'],
    ['rcv:faturamento:percursos', 'RC-V — percursos'],
    ['rcv:faturamento:descontos', 'RC-V — descontos'],
    ['rcv:faturamento:agravos', 'RC-V — agravos']
  ].map(([key, label]) => ({
    key,
    group: 'future',
    label: 'UI — ' + label,
    description:
      'Configuração detectada no Portal da Seguradora, mas não localizada como comportamento direto do motor nesta auditoria. Mantida como GAP planejado.',
    source: { kind: 'BUSINESS_SETTING' as const, path: 'Portal da Seguradora -> ' + key },
    value_type: 'STRING' as const,
    engine_status: 'PLANNED' as const,
    generation: 'MANUAL_ONLY' as const,
    tags: ['portal-contract', 'gap', 'p1']
  }))
];

flags.push(
  ...portalUiContractFlags.filter(
    (candidate) => !flags.some((existing) => existing.key === candidate.key)
  )
);


suites.push({
  key: 'p1-portal-ui-contract',
  label: 'P1 — Contrato Portal da Seguradora → Motor',
  description:
    'Valida aliases ativos usados pela interface e torna explícitas configurações da UI que ainda são GAP de produto.',
  priority: 'P1',
  tags: ['portal-contract', 'compatibility'],
  flag_keys: [
    ...portalUiContractFlags.map((flag) => flag.key),
    'regras:averbacao-esporadica-on'
  ]
});

export function getTestLabCatalog() {
  const active = flags.filter((item) => item.engine_status === 'ACTIVE').length;
  const invariants = flags.filter((item) => item.engine_status === 'INVARIANT').length;
  const planned = flags.filter((item) => item.engine_status === 'PLANNED').length;

  return {
    version: '1.0.0',
    environment_guard: 'TEST_ONLY',
    extension_contract: {
      description:
        'Para incluir uma nova regra na interface, adicione uma TestLabFlagDefinition ao catálogo. A UI é orientada a metadados e não deve codificar flags individualmente.',
      required_fields: [
        'key',
        'group',
        'label',
        'description',
        'source',
        'value_type',
        'engine_status',
        'generation',
        'tags'
      ]
    },
    summary: {
      total_flags: flags.length,
      active,
      invariants,
      planned,
      groups: groups.length,
      suites: suites.length
    },
    groups: [...groups].sort((a, b) => a.order - b.order),
    flags,
    suites
  };
}
