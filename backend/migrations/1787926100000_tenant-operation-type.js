/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('tenants', {
    tipo_operacao: { type: 'varchar', notNull: true, default: 'TRANSPORTADOR' }
  });
  pgm.addConstraint('tenants', 'tenants_tipo_operacao_check', {
    check: "tipo_operacao IN ('TRANSPORTADOR', 'EMBARCADOR', 'AMBOS')"
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('tenants', 'tenants_tipo_operacao_check');
  pgm.dropColumn('tenants', 'tipo_operacao');
};
