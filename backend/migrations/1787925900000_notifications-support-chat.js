/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('operational_notifications', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    tenant_user_id: { type: 'varchar', references: 'tenant_users', onDelete: 'CASCADE' },
    type: { type: 'varchar', notNull: true },
    severity: { type: 'varchar', notNull: true },
    title: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    context: { type: 'jsonb' },
    read_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('operational_notifications', 'tenant_id');
  pgm.createIndex('operational_notifications', 'tenant_user_id');
  pgm.createIndex('operational_notifications', ['tenant_id', 'read_at']);

  pgm.sql("ALTER TYPE support_ticket_status ADD VALUE IF NOT EXISTS 'EM_ATENDIMENTO'");
  pgm.sql("ALTER TYPE support_ticket_status ADD VALUE IF NOT EXISTS 'AGUARDANDO_CLIENTE'");
  pgm.sql("ALTER TYPE support_ticket_status ADD VALUE IF NOT EXISTS 'RESOLVIDO'");

  pgm.addColumns('support_tickets', {
    prioridade: { type: 'varchar', notNull: true, default: 'NORMAL' },
    canal_origem: { type: 'varchar', notNull: true, default: 'PORTAL' },
    tenant_user_id: { type: 'varchar', references: 'tenant_users', onDelete: 'SET NULL' },
    assigned_to: { type: 'text' },
    updated_at: { type: 'timestamptz' },
    resolved_at: { type: 'timestamptz' },
    closed_at: { type: 'timestamptz' }
  });

  pgm.sql("UPDATE support_tickets SET updated_at = created_at WHERE updated_at IS NULL");
  pgm.alterColumn('support_tickets', 'updated_at', { notNull: true });

  pgm.createTable('support_messages', {
    id: { type: 'varchar', primaryKey: true },
    ticket_id: { type: 'varchar', notNull: true, references: 'support_tickets', onDelete: 'CASCADE' },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    author_type: { type: 'varchar', notNull: true },
    author_id: { type: 'varchar' },
    author_name: { type: 'text', notNull: true },
    channel: { type: 'varchar', notNull: true },
    message: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('support_messages', 'ticket_id');
  pgm.createIndex('support_messages', 'tenant_id');
};

exports.down = (pgm) => {
  pgm.dropTable('support_messages');
  pgm.dropColumns('support_tickets', [
    'prioridade',
    'canal_origem',
    'tenant_user_id',
    'assigned_to',
    'updated_at',
    'resolved_at',
    'closed_at'
  ]);
  pgm.dropTable('operational_notifications');
  // Valores adicionados ao enum support_ticket_status não são removidos no down.
};
