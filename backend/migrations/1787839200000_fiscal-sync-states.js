/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createType('fiscal_sync_provider', ['NFE', 'CTE', 'MDFE']);
  pgm.createType('fiscal_sync_status', ['NEVER_SYNCED', 'OK', 'NO_DOCUMENTS', 'RATE_LIMITED', 'ERROR']);

  pgm.createTable('fiscal_sync_states', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    connector_id: { type: 'varchar', notNull: true, references: 'connectors', onDelete: 'CASCADE' },
    provider: { type: 'fiscal_sync_provider', notNull: true },
    status: { type: 'fiscal_sync_status', notNull: true, default: 'NEVER_SYNCED' },
    ult_nsu: { type: 'varchar' },
    max_nsu: { type: 'varchar' },
    last_cstat: { type: 'integer' },
    last_message: { type: 'text' },
    last_document_count: { type: 'integer', notNull: true, default: 0 },
    last_sync_at: { type: 'timestamptz' },
    next_sync_after: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('fiscal_sync_states', 'fiscal_sync_states_connector_provider_unique', {
    unique: ['connector_id', 'provider']
  });
  pgm.createIndex('fiscal_sync_states', 'tenant_id');
  pgm.createIndex('fiscal_sync_states', 'connector_id');
  pgm.createIndex('fiscal_sync_states', 'provider');
};

exports.down = (pgm) => {
  pgm.dropTable('fiscal_sync_states');
  pgm.dropType('fiscal_sync_status');
  pgm.dropType('fiscal_sync_provider');
};
