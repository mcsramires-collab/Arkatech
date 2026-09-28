/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('whatsapp_messages', {
    claimed_by: { type: 'varchar' },
    claim_token: { type: 'varchar' },
    claim_expires_at: { type: 'timestamptz' },
    attempt_count: { type: 'integer', notNull: true, default: 0 }
  });

  pgm.createIndex('whatsapp_messages', ['direction', 'status', 'claim_expires_at']);
};

exports.down = (pgm) => {
  pgm.dropIndex('whatsapp_messages', ['direction', 'status', 'claim_expires_at']);
  pgm.dropColumns('whatsapp_messages', [
    'claimed_by',
    'claim_token',
    'claim_expires_at',
    'attempt_count'
  ]);
};
