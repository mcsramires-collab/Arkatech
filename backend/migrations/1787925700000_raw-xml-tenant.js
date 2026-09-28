/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Registros antigos podem ficar sem tenant_id; todo novo RawXMLStore da aplicação informa o tenant.
  pgm.addColumn('raw_xml_store', {
    tenant_id: { type: 'varchar', references: 'tenants', onDelete: 'CASCADE' }
  });
  pgm.createIndex('raw_xml_store', 'tenant_id');
  pgm.createIndex('raw_xml_store', ['tenant_id', 'hash_sha256']);
};

exports.down = (pgm) => {
  pgm.dropIndex('raw_xml_store', ['tenant_id', 'hash_sha256']);
  pgm.dropIndex('raw_xml_store', 'tenant_id');
  pgm.dropColumn('raw_xml_store', 'tenant_id');
};
