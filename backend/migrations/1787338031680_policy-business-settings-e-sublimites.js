/* eslint-disable camelcase */

/**
 * Fase 0 do plano de migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project)
 * — extensão do schema criado em 1787257248207_init-schema.js para as duas novas entidades da
 * Ficha do Segurado real (Portal da Seguradora): PolicyBusinessSettings e PolicySublimite
 * (ver backend/src/types/index.ts). Mesma regra da migration inicial: isto só desenha o
 * schema, espelhado pelo `pgMirror.ts` — nenhuma rota lê/escreve direto no Postgres ainda.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ===================== POLICY_BUSINESS_SETTINGS =====================
  // Blob de configurações por apólice (Métodos de Averbação, Subcontratação, Veículo e
  // Motorista, Prazos e Datas, Região Metropolitana, Valor da Averbação, Averbação
  // Esporádica) — ver comentário de PolicyBusinessSettings em src/types/index.ts sobre por
  // que isso é um jsonb solto em vez de uma tabela por sub-seção.
  pgm.createTable('policy_business_settings', {
    id: { type: 'varchar', primaryKey: true },
    policy_id: {
      type: 'varchar',
      notNull: true,
      unique: true,
      references: 'policies',
      onDelete: 'CASCADE'
    },
    config: { type: 'jsonb', notNull: true, default: '{}' },
    updated_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('policy_business_settings', 'policy_id');

  // ===================== POLICY_SUBLIMITES =====================
  pgm.createTable('policy_sublimites', {
    id: { type: 'varchar', primaryKey: true },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'CASCADE' },
    tag: { type: 'text', notNull: true },
    valor: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('policy_sublimites', 'policy_id');
};

exports.down = (pgm) => {
  pgm.dropTable('policy_sublimites');
  pgm.dropTable('policy_business_settings');
};
