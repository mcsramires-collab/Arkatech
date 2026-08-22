/* eslint-disable camelcase */

/**
 * Fase 0 do plano de migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project)
 * — extensão do schema para as duas novas entidades de Segurança/Portal da Seguradora
 * (backlog itens 1 e 2, ver claude/Backlog_Proximos_Passos.md no Project):
 *
 * - DelegationException: override por segurado da matriz de delegação (aba "Exceções por
 *   segurado" em Permissões e Autonomia).
 * - PolicyCoverageValue: valor real (R$) de uma Cobertura Adicional dentro de uma apólice
 *   específica.
 *
 * Ver comentários de ambas em backend/src/types/index.ts. Mesma regra das migrations
 * anteriores: isto só desenha o schema, espelhado pelo `pgMirror.ts` — nenhuma rota lê/escreve
 * direto no Postgres ainda.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ===================== DELEGATION_EXCEPTIONS =====================
  pgm.createType('delegation_exception_nivel', ['AUTONOMO', 'MEDIANTE_APROVACAO', 'BLOQUEADA']);

  pgm.createTable('delegation_exceptions', {
    id: { type: 'varchar', primaryKey: true },
    insurer_id: { type: 'varchar', notNull: true, references: 'insurers', onDelete: 'CASCADE' },
    broker_id: { type: 'varchar', notNull: true, references: 'brokers', onDelete: 'CASCADE' },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    nivel: { type: 'delegation_exception_nivel', notNull: true },
    created_at: { type: 'timestamptz', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true }
  });
  // Uma corretora tem no máximo uma exceção por segurado dentro da carteira de uma seguradora.
  pgm.addConstraint('delegation_exceptions', 'delegation_exceptions_unico_por_segurado', {
    unique: ['insurer_id', 'broker_id', 'tenant_id']
  });
  pgm.createIndex('delegation_exceptions', ['insurer_id', 'broker_id']);

  // ===================== POLICY_COVERAGE_VALUES =====================
  pgm.createTable('policy_coverage_values', {
    id: { type: 'varchar', primaryKey: true },
    policy_id: { type: 'varchar', notNull: true, references: 'policies', onDelete: 'CASCADE' },
    insurer_coverage_id: { type: 'varchar', notNull: true, references: 'insurer_coverages', onDelete: 'CASCADE' },
    valor: { type: 'numeric', notNull: true, default: 0 },
    desconta_lmi: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true }
  });
  // Uma cobertura só pode ser ativada uma vez por apólice — edições alteram o registro existente.
  pgm.addConstraint('policy_coverage_values', 'policy_coverage_values_unico_por_apolice', {
    unique: ['policy_id', 'insurer_coverage_id']
  });
  pgm.createIndex('policy_coverage_values', 'policy_id');
};

exports.down = (pgm) => {
  pgm.dropTable('policy_coverage_values');
  pgm.dropTable('delegation_exceptions');
  pgm.dropType('delegation_exception_nivel');
};
