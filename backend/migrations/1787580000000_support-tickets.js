/* eslint-disable camelcase */

/**
 * Tela de Suporte real do Portal do Segurado (backlog, achado da auditoria de 27/08) — até aqui
 * o formulário só disparava um toast de sucesso no cliente, sem nenhuma chamada de API. Ver
 * `SupportTicket` em backend/src/types/index.ts.
 *
 * Mesma regra das migrations anteriores: isto só desenha o schema, espelhado pelo `pgMirror.ts`
 * — nenhuma rota lê/escreve direto no Postgres ainda.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createType('support_ticket_status', ['ABERTO', 'FECHADO']);

  pgm.createTable('support_tickets', {
    id: { type: 'varchar', primaryKey: true },
    tenant_id: { type: 'varchar', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    assunto: { type: 'text', notNull: true },
    categoria: { type: 'text', notNull: true },
    descricao: { type: 'text', notNull: true },
    status: { type: 'support_ticket_status', notNull: true, default: 'ABERTO' },
    solicitante_nome: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true }
  });
  pgm.createIndex('support_tickets', 'tenant_id');
};

exports.down = (pgm) => {
  pgm.dropTable('support_tickets');
  pgm.dropType('support_ticket_status');
};
