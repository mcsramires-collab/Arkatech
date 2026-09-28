/* eslint-disable camelcase */

/**
 * Alinha o schema Postgres com o modelo de averbação já usado pelo backend.
 *
 * O enum original nasceu com SUCESSO/ERRO. O motor hoje também persiste pendências e
 * cancelamentos; sem esta migration o espelhamento falha ao encontrar esses estados.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql("ALTER TYPE averbacao_status ADD VALUE IF NOT EXISTS 'PENDENTE_APROVACAO'");
  pgm.sql("ALTER TYPE averbacao_status ADD VALUE IF NOT EXISTS 'CANCELADO_NAO_AVERBADO'");
  pgm.sql("ALTER TYPE averbacao_status ADD VALUE IF NOT EXISTS 'CANCELADO'");

  pgm.addColumns('averbacoes', {
    motivo_pendencia: { type: 'varchar' },
    lmi_no_momento_envio: { type: 'numeric' },
    sublimite_no_momento_envio: { type: 'numeric' },
    codigo_liberacao_utilizado: { type: 'varchar' },
    decidido_por: { type: 'text' },
    decidido_em: { type: 'timestamptz' },
    protocolo_cancelamento_sefaz: { type: 'varchar' },
    justificativa_cancelamento: { type: 'text' },
    cancelado_em: { type: 'timestamptz' },
    cancelado_por: { type: 'varchar' },
    cnpj_emissor: { type: 'varchar(18)' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('averbacoes', [
    'motivo_pendencia',
    'lmi_no_momento_envio',
    'sublimite_no_momento_envio',
    'codigo_liberacao_utilizado',
    'decidido_por',
    'decidido_em',
    'protocolo_cancelamento_sefaz',
    'justificativa_cancelamento',
    'cancelado_em',
    'cancelado_por',
    'cnpj_emissor'
  ]);

  // Valores de ENUM não são removidos no down: o PostgreSQL não oferece DROP VALUE seguro.
};
