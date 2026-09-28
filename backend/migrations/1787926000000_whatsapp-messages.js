/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('whatsapp_messages', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    tenant_user_id: { type: 'varchar', references: 'tenant_users', onDelete: 'SET NULL' },
    provider: { type: 'varchar', notNull: true },
    provider_message_id: { type: 'varchar' },
    direction: { type: 'varchar', notNull: true },
    kind: { type: 'varchar', notNull: true },
    phone: { type: 'varchar', notNull: true },
    text: { type: 'text' },
    document_name: { type: 'text' },
    document_mime_type: { type: 'varchar' },
    content_hash_sha256: { type: 'varchar' },
    status: { type: 'varchar', notNull: true },
    support_ticket_id: { type: 'varchar', references: 'support_tickets', onDelete: 'SET NULL' },
    fiscal_document_ids: { type: 'jsonb', notNull: true, default: '[]' },
    error_message: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true },
    processed_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('whatsapp_messages', 'tenant_id');
  pgm.createIndex('whatsapp_messages', 'support_ticket_id');
  pgm.createIndex('whatsapp_messages', ['direction', 'status']);
  pgm.sql(
    "CREATE UNIQUE INDEX whatsapp_messages_inbound_provider_message_uidx " +
      "ON whatsapp_messages(provider, provider_message_id) " +
      "WHERE direction = 'INBOUND' AND provider_message_id IS NOT NULL"
  );
};

exports.down = (pgm) => {
  pgm.dropTable('whatsapp_messages');
};
