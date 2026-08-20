/* eslint-disable camelcase */

/**
 * Fase 0 do plano de migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project).
 *
 * Este arquivo cria o schema completo das 23 entidades hoje mantidas em memória por
 * `backend/src/services/dbStore.ts`, espelhando exatamente os campos de
 * `backend/src/types/index.ts`. Esta migration NÃO é usada por nenhuma rota ainda — é só
 * o desenho do schema, validado rodando de verdade contra um Postgres local antes do PR.
 *
 * Decisões de modelagem (detalhadas no plano):
 * - IDs continuam `varchar` (não `uuid` nativo) para bater 1:1 com os IDs já existentes em
 *   produção (uuidv4() em string, e alguns IDs fixos como "tenant_expressa_teste").
 * - Enums do TypeScript viram ENUM nativo do Postgres.
 * - Objetos/arrays sem necessidade de consulta relacional (`permissions`, `payload`,
 *   `metricas_globais`, `metricas_por_cliente`) ficam `jsonb`.
 * - Arrays simples (`placeholders`, `regras_internas_aplicadas`, `variaveis_faltantes`)
 *   usam o tipo array nativo do Postgres.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ===================== ENUMS =====================
  pgm.createType('status_ativo_inativo', ['ATIVO', 'INATIVO']);
  pgm.createType('tenant_environment', ['teste', 'producao']);
  pgm.createType('user_role', ['ADMIN', 'SEGURADORA', 'CORRETORA', 'TRANSPORTADOR']);
  pgm.createType('ramo_apolice', ['RCTRC', 'RCDC', 'RCV']);
  pgm.createType('tipo_documento', ['CTE', 'NFE', 'NFSE', 'MDFE']);
  pgm.createType('policy_status', ['ATIVA', 'INATIVA', 'VENCIDA']);
  pgm.createType('funcao_documento', [
    'EMISSOR',
    'DESTINATARIO',
    'REMETENTE',
    'TOMADOR',
    'EXPEDIDOR',
    'RECEBEDOR'
  ]);
  pgm.createType('delegation_action', [
    'CRIAR_CLIENTE',
    'EDITAR_CLIENTE',
    'CRIAR_APOLICE',
    'EDITAR_APOLICE',
    'CRIAR_COBERTURA_ADICIONAL',
    'EDITAR_COBERTURA_ADICIONAL'
  ]);
  pgm.createType('internal_user_role', ['ADM', 'AGENTE']);
  pgm.createType('document_rule_origem', ['SEFAZ_PADRAO', 'CUSTOM']);
  pgm.createType('response_template_tipo', ['sucesso', 'erro', 'aviso']);
  pgm.createType('response_template_categoria', [
    'AUTENTICACAO',
    'CADASTRO',
    'APOLICE',
    'REGRA_XML',
    'SISTEMA'
  ]);
  pgm.createType('averbacao_status', ['SUCESSO', 'ERRO']);
  pgm.createType('batch_run_distribuicao', ['ROUND_ROBIN', 'CUSTOM']);
  pgm.createType('batch_run_status', ['PENDENTE', 'PROCESSANDO', 'CONCLUIDO']);
  pgm.createType('rbac_owner_type', ['SEGURADORA', 'CORRETORA', 'ARCKATECH']);
  pgm.createType('coverage_tipo_valor', ['monetario', 'informativo']);
  pgm.createType('approval_status', ['PENDENTE', 'APROVADO', 'REJEITADO']);
  pgm.createType('notification_canal', ['EMAIL', 'PORTAL', 'SMS']);
  pgm.createType('business_rule_status', ['PENDENTE', 'APROVADA', 'REJEITADA']);

  // ===================== TENANTS =====================
  pgm.createTable('tenants', {
    id: { type: 'varchar', primaryKey: true },
    cnpj: { type: 'varchar(18)', notNull: true },
    razao_social: { type: 'text', notNull: true },
    status: { type: 'status_ativo_inativo', notNull: true },
    ambiente: { type: 'tenant_environment', notNull: true },
    client_id: { type: 'varchar', notNull: true, unique: true },
    client_secret_hash: { type: 'text', notNull: true },
    role: { type: 'user_role', notNull: true },
    token_duration_hours: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true },
    contato_nome: { type: 'text' },
    contato_email: { type: 'text' },
    contato_telefone_fixo: { type: 'text' },
    contato_celular: { type: 'text' },
    conta_ativada: { type: 'boolean' }
  });

  // ===================== INSURERS =====================
  pgm.createTable('insurers', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', references: 'tenants', onDelete: 'SET NULL' },
    cnpj: { type: 'varchar(18)', notNull: true },
    nome: { type: 'text', notNull: true },
    razao_social: { type: 'text' },
    nome_fantasia: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== BROKERS =====================
  pgm.createTable('brokers', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', references: 'tenants', onDelete: 'SET NULL' },
    cnpj: { type: 'varchar(18)', notNull: true },
    nome: { type: 'text', notNull: true },
    razao_social: { type: 'text' },
    nome_fantasia: { type: 'text' },
    corretor_responsavel_nome: { type: 'text' },
    corretor_responsavel_email: { type: 'text' },
    corretor_responsavel_telefone_fixo: { type: 'text' },
    corretor_responsavel_celular: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== RBAC_PROFILES =====================
  // owner_id é polimórfico (aponta pra insurers.id OU brokers.id, dependendo de owner_type;
  // nulo quando owner_type = ARCKATECH) — por isso não tem FK, fica documentado aqui.
  pgm.createTable('rbac_profiles', {
    id: { type: 'varchar', primaryKey: true },
    owner_type: { type: 'rbac_owner_type', notNull: true },
    owner_id: { type: 'varchar' },
    nome_perfil: { type: 'text', notNull: true },
    permissions: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== INTERNAL_USERS =====================
  pgm.createTable('internal_users', {
    id: { type: 'varchar', primaryKey: true },
    nome: { type: 'text', notNull: true },
    email: { type: 'varchar', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'internal_user_role', notNull: true },
    rbac_profile_id: { type: 'varchar', references: 'rbac_profiles', onDelete: 'SET NULL' },
    status: { type: 'status_ativo_inativo', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== TENANT_USERS =====================
  // Mesmo e-mail pode existir em tenants diferentes (login multi-empresa), mas não duas
  // vezes no mesmo tenant — por isso o UNIQUE é composto (tenant_id, email), não só email.
  pgm.createTable('tenant_users', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    nome: { type: 'text', notNull: true },
    email: { type: 'varchar', notNull: true },
    password_hash: { type: 'text', notNull: true },
    rbac_profile_id: { type: 'varchar', references: 'rbac_profiles', onDelete: 'SET NULL' },
    is_admin_da_conta: { type: 'boolean' },
    status: { type: 'status_ativo_inativo', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.addConstraint('tenant_users', 'tenant_users_tenant_id_email_unique', {
    unique: ['tenant_id', 'email']
  });

  // ===================== POLICIES =====================
  pgm.createTable('policies', {
    id: { type: 'varchar', primaryKey: true },
    numero_apolice: { type: 'varchar', notNull: true },
    ramo: { type: 'ramo_apolice', notNull: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    insurer_id: { type: 'varchar', notNull: true, references: 'insurers', onDelete: 'RESTRICT' },
    broker_id: { type: 'varchar', notNull: true, references: 'brokers', onDelete: 'RESTRICT' },
    co_broker_id: { type: 'varchar', references: 'brokers', onDelete: 'SET NULL' },
    assessoria_id: { type: 'varchar', references: 'brokers', onDelete: 'SET NULL' },
    status: { type: 'policy_status', notNull: true },
    permitir_inativo_vencido: { type: 'boolean', notNull: true, default: false },
    vigencia_inicio: { type: 'timestamptz', notNull: true },
    vigencia_fim: { type: 'timestamptz', notNull: true },
    lmi: { type: 'numeric' },
    // @deprecated — mantido só por compatibilidade, ver PolicyTitularityRule.
    aceita_averbacao_como_destinatario: { type: 'boolean', notNull: true, default: false }
  });
  pgm.createIndex('policies', 'tenant_id');

  // ===================== POLICY_TITULARITY_RULES =====================
  pgm.createTable('policy_titularity_rules', {
    id: { type: 'varchar', primaryKey: true },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'CASCADE' },
    funcao: { type: 'funcao_documento', notNull: true },
    habilitada: { type: 'boolean', notNull: true, default: false }
  });
  pgm.createIndex('policy_titularity_rules', 'policy_id');

  // ===================== POLICY_BYPASS_RULES =====================
  pgm.createTable('policy_bypass_rules', {
    id: { type: 'varchar', primaryKey: true },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'CASCADE' },
    rota_uf_origem: { type: 'varchar(2)' },
    rota_uf_destino: { type: 'varchar(2)' },
    produto_predominante: { type: 'text' }
  });
  pgm.createIndex('policy_bypass_rules', 'policy_id');

  // ===================== POLICY_RULES =====================
  pgm.createTable('policy_rules', {
    id: { type: 'varchar', primaryKey: true },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'CASCADE' },
    // TipoDocumento | 'TODOS' — não é o enum tipo_documento puro, por isso varchar.
    tipo_doc: { type: 'varchar', notNull: true },
    tag_path: { type: 'text', notNull: true },
    nome_variavel: { type: 'text', notNull: true },
    obrigatoria: { type: 'boolean', notNull: true, default: false },
    exemplo_preenchimento: { type: 'text' },
    instrucao_recuperacao: { type: 'text' }
  });
  pgm.createIndex('policy_rules', 'policy_id');

  // ===================== DOCUMENT_RULES =====================
  pgm.createTable('document_rules', {
    id: { type: 'varchar', primaryKey: true },
    tipo_documento: { type: 'tipo_documento', notNull: true },
    tag_path: { type: 'text', notNull: true },
    nome_variavel: { type: 'text', notNull: true },
    obrigatoria: { type: 'boolean', notNull: true, default: false },
    origem: { type: 'document_rule_origem', notNull: true },
    observacao: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== RESPONSE_TEMPLATES =====================
  pgm.createTable('response_templates', {
    id: { type: 'varchar', primaryKey: true },
    codigo: { type: 'varchar', notNull: true, unique: true },
    tipo: { type: 'response_template_tipo', notNull: true },
    categoria: { type: 'response_template_categoria', notNull: true },
    texto_padrao: { type: 'text', notNull: true },
    texto_customizado: { type: 'text', notNull: true },
    placeholders: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
    explicacao_nao_tecnica: { type: 'text' },
    orientacao_correcao: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== RAW_XML_STORE =====================
  pgm.createTable('raw_xml_store', {
    id: { type: 'varchar', primaryKey: true },
    content_xml: { type: 'text', notNull: true },
    hash_sha256: { type: 'varchar(64)', notNull: true },
    encrypted_aes256: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('raw_xml_store', 'hash_sha256');

  // ===================== AVERBACOES =====================
  pgm.createTable('averbacoes', {
    id: { type: 'varchar', primaryKey: true },
    // Ausente em registros status='ERRO' — só é gerado quando a averbação é aceita.
    numero_averbacao: { type: 'varchar' },
    protocolo_interno_averbacao: { type: 'varchar', notNull: true, unique: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'RESTRICT' },
    status: { type: 'averbacao_status', notNull: true },
    codigo_resposta: { type: 'varchar', notNull: true },
    mensagem_resposta: { type: 'text', notNull: true },
    valor_carga: { type: 'numeric', notNull: true },
    valor_considerado_averbacao: { type: 'numeric', notNull: true },
    regras_internas_aplicadas: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
    // 1=produção, 2=homologação — extraído do XML, independente do tenant.ambiente.
    tp_amb_sefaz: { type: 'smallint' },
    tipo_documento: { type: 'tipo_documento', notNull: true },
    chave_documento: { type: 'varchar(44)', notNull: true },
    numero_documento: { type: 'varchar' },
    serie_documento: { type: 'varchar' },
    cnpj_remetente: { type: 'varchar(18)' },
    cnpj_destinatario: { type: 'varchar(18)' },
    cnpj_tomador: { type: 'varchar(18)' },
    protocolo_aceitacao_sefaz: { type: 'varchar' },
    raw_xml_id: { type: 'varchar', notNull: true, references: 'raw_xml_store', onDelete: 'RESTRICT' },
    recovery_token: { type: 'varchar' },
    ambiente: { type: 'tenant_environment', notNull: true },
    timestamp: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('averbacoes', 'tenant_id');
  pgm.createIndex('averbacoes', 'chave_documento');
  pgm.createIndex('averbacoes', 'protocolo_aceitacao_sefaz');
  pgm.createIndex('averbacoes', 'status');

  // ===================== RECOVERY_SESSIONS =====================
  pgm.createTable('recovery_sessions', {
    token: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'CASCADE' },
    tipo_documento: { type: 'tipo_documento', notNull: true },
    raw_xml_content: { type: 'text', notNull: true },
    variaveis_faltantes: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
    expira_em: { type: 'timestamptz', notNull: true },
    utilizada: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('recovery_sessions', 'tenant_id');

  // ===================== BATCH_TEST_RUNS =====================
  // configuracao_clientes / metricas_globais / metricas_por_cliente: estruturas usadas só
  // pela ferramenta interna de teste de carga — não compensa normalizar, ficam jsonb.
  pgm.createTable('batch_test_runs', {
    id: { type: 'varchar', primaryKey: true },
    total_docs: { type: 'integer', notNull: true },
    distribuicao: { type: 'batch_run_distribuicao', notNull: true },
    status: { type: 'batch_run_status', notNull: true },
    configuracao_clientes: { type: 'jsonb', notNull: true },
    metricas_globais: { type: 'jsonb', notNull: true },
    metricas_por_cliente: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== INSURER_COVERAGE_TEMPLATES =====================
  pgm.createTable('insurer_coverage_templates', {
    id: { type: 'varchar', primaryKey: true },
    titulo: { type: 'text', notNull: true },
    ativo: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== INSURER_COVERAGES =====================
  pgm.createTable('insurer_coverages', {
    id: { type: 'varchar', primaryKey: true },
    insurer_id: { type: 'varchar', notNull: true, references: 'insurers', onDelete: 'CASCADE' },
    // nulo = aplica a todos os ramos daquela seguradora.
    ramo: { type: 'ramo_apolice' },
    titulo: { type: 'text', notNull: true },
    exemplo_preenchimento: { type: 'text' },
    obrigatoria: { type: 'boolean', notNull: true, default: false },
    aplicar_todos_clientes: { type: 'boolean', notNull: true, default: true },
    // obrigatório se aplicar_todos_clientes = false — checado na aplicação, não no banco.
    tenant_id: { type: 'varchar', references: 'tenants', onDelete: 'CASCADE' },
    tipo_valor: { type: 'coverage_tipo_valor', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('insurer_coverages', 'insurer_id');

  // ===================== DELEGATION_PERMISSIONS =====================
  pgm.createTable('delegation_permissions', {
    id: { type: 'varchar', primaryKey: true },
    insurer_id: { type: 'varchar', notNull: true, references: 'insurers', onDelete: 'CASCADE' },
    broker_id: { type: 'varchar', notNull: true, references: 'brokers', onDelete: 'CASCADE' },
    action: { type: 'delegation_action', notNull: true },
    requires_approval: { type: 'boolean', notNull: true, default: false }
  });

  // ===================== APPROVAL_REQUESTS =====================
  pgm.createTable('approval_requests', {
    id: { type: 'varchar', primaryKey: true },
    insurer_id: { type: 'varchar', notNull: true, references: 'insurers', onDelete: 'CASCADE' },
    broker_id: { type: 'varchar', notNull: true, references: 'brokers', onDelete: 'CASCADE' },
    action: { type: 'delegation_action', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    status: { type: 'approval_status', notNull: true },
    created_at: { type: 'timestamptz', notNull: true },
    resolved_at: { type: 'timestamptz' },
    resolved_by: { type: 'varchar', references: 'internal_users', onDelete: 'SET NULL' }
  });
  pgm.createIndex('approval_requests', 'status');

  // ===================== ACTIVATION_TOKENS =====================
  pgm.createTable('activation_tokens', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    token: { type: 'varchar', notNull: true, unique: true },
    termo_versao: { type: 'varchar', notNull: true },
    aceite: { type: 'boolean', notNull: true, default: false },
    aceite_em: { type: 'timestamptz' },
    expira_em: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });

  // ===================== NOTIFICATION_PREFERENCES =====================
  pgm.createTable('notification_preferences', {
    id: { type: 'varchar', primaryKey: true },
    tenant_user_id: {
      type: 'varchar',
      notNull: true,
      references: 'tenant_users',
      onDelete: 'CASCADE'
    },
    canal: { type: 'notification_canal', notNull: true },
    ativo: { type: 'boolean', notNull: true, default: true }
  });
  pgm.createIndex('notification_preferences', 'tenant_user_id');

  // ===================== BUSINESS_RULE_REQUESTS =====================
  pgm.createTable('business_rule_requests', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    tipo: { type: 'text', notNull: true },
    descricao: { type: 'text' },
    status: { type: 'business_rule_status', notNull: true },
    solicitante_nome: { type: 'text', notNull: true },
    comentario_seguradora: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true },
    resolved_at: { type: 'timestamptz' }
  });
  pgm.createIndex('business_rule_requests', 'tenant_id');
};

exports.down = (pgm) => {
  // Ordem inversa da criação, para respeitar as foreign keys.
  pgm.dropTable('business_rule_requests');
  pgm.dropTable('notification_preferences');
  pgm.dropTable('activation_tokens');
  pgm.dropTable('approval_requests');
  pgm.dropTable('delegation_permissions');
  pgm.dropTable('insurer_coverages');
  pgm.dropTable('insurer_coverage_templates');
  pgm.dropTable('batch_test_runs');
  pgm.dropTable('recovery_sessions');
  pgm.dropTable('averbacoes');
  pgm.dropTable('raw_xml_store');
  pgm.dropTable('response_templates');
  pgm.dropTable('document_rules');
  pgm.dropTable('policy_rules');
  pgm.dropTable('policy_bypass_rules');
  pgm.dropTable('policy_titularity_rules');
  pgm.dropTable('policies');
  pgm.dropTable('tenant_users');
  pgm.dropTable('internal_users');
  pgm.dropTable('rbac_profiles');
  pgm.dropTable('brokers');
  pgm.dropTable('insurers');
  pgm.dropTable('tenants');

  pgm.dropType('business_rule_status');
  pgm.dropType('notification_canal');
  pgm.dropType('approval_status');
  pgm.dropType('coverage_tipo_valor');
  pgm.dropType('rbac_owner_type');
  pgm.dropType('batch_run_status');
  pgm.dropType('batch_run_distribuicao');
  pgm.dropType('averbacao_status');
  pgm.dropType('response_template_categoria');
  pgm.dropType('response_template_tipo');
  pgm.dropType('document_rule_origem');
  pgm.dropType('internal_user_role');
  pgm.dropType('delegation_action');
  pgm.dropType('funcao_documento');
  pgm.dropType('policy_status');
  pgm.dropType('tipo_documento');
  pgm.dropType('ramo_apolice');
  pgm.dropType('user_role');
  pgm.dropType('tenant_environment');
  pgm.dropType('status_ativo_inativo');
};
