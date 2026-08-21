import { Pool } from 'pg';

/**
 * Fase 1 da migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project) — modo
 * "espelhamento automático": este pool só é usado por `pgMirror.ts` para manter o Postgres
 * sincronizado como cópia fiel do `dbStore` em memória. Nenhuma rota lê deste pool ainda —
 * isso só acontece na Fase 3 (corte), quando o Postgres vira a fonte de verdade de fato.
 *
 * Deliberadamente tolerante à ausência de `DATABASE_URL`: em dev local, ou em produção antes do
 * Postgres ser provisionado no Easypanel, o pool simplesmente não é criado e o espelhamento vira
 * um no-op — o app continua funcionando 100% como antes, só em memória/arquivo.
 */

let pool: Pool | null = null;
let poolInitAttempted = false;

export function isPgConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

export function getPgPool(): Pool | null {
  if (!isPgConfigured()) {
    return null;
  }

  if (!poolInitAttempted) {
    poolInitAttempted = true;
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Alguns provedores de Postgres gerenciado exigem SSL mesmo em rede interna;
      // fica opt-in via env var para não quebrar o caso comum (Postgres do próprio
      // Easypanel na mesma rede do serviço, sem SSL).
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: 5
    });

    pool.on('error', (err) => {
      // Erro numa conexão ociosa do pool — não deve derrubar o processo.
      console.error('[pgPool] Erro inesperado numa conexão ociosa do pool Postgres:', err);
    });
  }

  return pool;
}
