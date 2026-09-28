/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createType('connector_status', ['ATIVO', 'REVOGADO']);
  pgm.createType('connector_certificate_status', ['NAO_CONFIGURADO', 'VALID', 'EXPIRING', 'EXPIRED', 'ERROR']);
  pgm.createType('connector_sefaz_status', ['UNKNOWN', 'ONLINE', 'DEGRADED', 'OFFLINE']);

  pgm.createTable('connectors', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    device_id: { type: 'varchar', notNull: true },
    device_name: { type: 'text', notNull: true },
    version: { type: 'varchar', notNull: true },
    os: { type: 'varchar', notNull: true },
    capabilities: { type: 'jsonb', notNull: true, default: '[]' },
    status: { type: 'connector_status', notNull: true, default: 'ATIVO' },
    device_token_hash: { type: 'varchar(64)', notNull: true },
    sefaz_status: { type: 'connector_sefaz_status', notNull: true, default: 'UNKNOWN' },
    last_heartbeat_at: { type: 'timestamptz' },
    last_sync_at: { type: 'timestamptz' },
    certificate_status: { type: 'connector_certificate_status', notNull: true, default: 'NAO_CONFIGURADO' },
    certificate_cnpj: { type: 'varchar(14)' },
    certificate_type: { type: 'varchar(2)' },
    certificate_issuer: { type: 'text' },
    certificate_serial_hash: { type: 'varchar(64)' },
    certificate_valid_from: { type: 'timestamptz' },
    certificate_valid_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' }
  });

  pgm.addConstraint('connectors', 'connectors_tenant_device_unique', {
    unique: ['tenant_id', 'device_id']
  });
  pgm.createIndex('connectors', 'tenant_id');
  pgm.createIndex('connectors', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('connectors');
  pgm.dropType('connector_sefaz_status');
  pgm.dropType('connector_certificate_status');
  pgm.dropType('connector_status');
};
