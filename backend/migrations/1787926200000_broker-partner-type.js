/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('brokers', {
    partner_type: { type: 'varchar', notNull: true, default: 'CORRETORA' }
  });
  pgm.addConstraint('brokers', 'brokers_partner_type_check', {
    check: "partner_type IN ('CORRETORA', 'ASSESSORIA', 'AMBOS')"
  });

  // Classifica o legado pelo papel já exercido nas apólices.
  pgm.sql(`
    UPDATE brokers b
    SET partner_type = CASE
      WHEN EXISTS (
        SELECT 1 FROM policies p
        WHERE p.assessoria_id = b.id
      ) AND EXISTS (
        SELECT 1 FROM policies p
        WHERE p.broker_id = b.id OR p.co_broker_id = b.id
      ) THEN 'AMBOS'
      WHEN EXISTS (
        SELECT 1 FROM policies p
        WHERE p.assessoria_id = b.id
      ) THEN 'ASSESSORIA'
      ELSE 'CORRETORA'
    END
  `);
};

exports.down = (pgm) => {
  pgm.dropConstraint('brokers', 'brokers_partner_type_check');
  pgm.dropColumn('brokers', 'partner_type');
};
