/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('brokers', {
    partner_type: { type: 'varchar', notNull: true, default: 'CORRETORA' }
  });
  pgm.addConstraint('brokers', 'brokers_partner_type_check', {
    check: "partner_type IN ('CORRETORA', 'ASSESSORIA', 'AMBOS')"
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('brokers', 'brokers_partner_type_check');
  pgm.dropColumn('brokers', 'partner_type');
};
