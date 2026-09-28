/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createType('fiscal_event_status', ['PROCESSADO', 'IGNORADO', 'DUPLICADO', 'ERRO']);

  pgm.createTable('fiscal_events', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    connector_id: { type: 'varchar', notNull: true, references: 'connectors', onDelete: 'CASCADE' },
    provider: { type: 'fiscal_sync_provider', notNull: true },
    nsu: { type: 'varchar' },
    tipo_evento: { type: 'varchar' },
    chave_documento: { type: 'varchar(44)' },
    status: { type: 'fiscal_event_status', notNull: true },
    content_hash_sha256: { type: 'varchar(64)', notNull: true },
    raw_xml_id: { type: 'varchar', notNull: true, references: 'raw_xml_store' },
    averbacao_ids: { type: 'jsonb', notNull: true, default: '[]' },
    mensagem: { type: 'text' },
    received_at: { type: 'timestamptz', notNull: true },
    processed_at: { type: 'timestamptz' }
  });

  pgm.createIndex('fiscal_events', 'tenant_id');
  pgm.createIndex('fiscal_events', 'connector_id');
  pgm.createIndex('fiscal_events', 'chave_documento');
  pgm.createIndex('fiscal_events', 'content_hash_sha256');
};

exports.down = (pgm) => {
  pgm.dropTable('fiscal_events');
  pgm.dropType('fiscal_event_status');
};
