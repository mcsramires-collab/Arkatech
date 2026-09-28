/* eslint-disable camelcase */

/**
 * Etapa 2 do pipeline multicanal: registro canônico de documentos fiscais recebidos.
 *
 * O documento nasce antes da averbação e guarda apenas metadados operacionais.
 * O XML bruto continua no raw_xml_store/averbações; o conteúdo não é duplicado aqui.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createType('document_ingestion_source', [
    'API',
    'PORTAL',
    'SEFAZ',
    'TMS',
    'WHATSAPP',
    'INTERNAL'
  ]);

  pgm.createType('fiscal_document_status', [
    'RECEBIDO',
    'PROCESSANDO',
    'AVERBADO',
    'PENDENTE',
    'RECUSADO',
    'IGNORADO',
    'DUPLICADO',
    'ERRO'
  ]);

  pgm.createTable('fiscal_documents', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    source: { type: 'document_ingestion_source', notNull: true },
    status: { type: 'fiscal_document_status', notNull: true, default: 'RECEBIDO' },
    content_hash_sha256: { type: 'varchar(64)', notNull: true },
    original_filename: { type: 'text' },
    tipo_documento: { type: 'tipo_documento' },
    chave_documento: { type: 'varchar(44)' },
    numero_documento: { type: 'varchar' },
    serie_documento: { type: 'varchar' },
    cnpj_emissor: { type: 'varchar(14)' },
    nsu: { type: 'varchar' },
    connector_id: { type: 'varchar' },
    external_id: { type: 'varchar' },
    policy_ids_attempted: { type: 'jsonb', notNull: true, default: '[]' },
    averbacao_ids: { type: 'jsonb', notNull: true, default: '[]' },
    codigo_resultado: { type: 'varchar' },
    mensagem_resultado: { type: 'text' },
    received_at: { type: 'timestamptz', notNull: true },
    processed_at: { type: 'timestamptz' }
  });

  pgm.createIndex('fiscal_documents', 'tenant_id');
  pgm.createIndex('fiscal_documents', 'status');
  pgm.createIndex('fiscal_documents', 'source');
  pgm.createIndex('fiscal_documents', 'content_hash_sha256');
  pgm.createIndex('fiscal_documents', 'chave_documento');
  pgm.createIndex('fiscal_documents', ['tenant_id', 'received_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('fiscal_documents');
  pgm.dropType('fiscal_document_status');
  pgm.dropType('document_ingestion_source');
};
