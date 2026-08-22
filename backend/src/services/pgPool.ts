import { Pool, PoolConfig } from 'pg';

/**
 * Fase 1 da migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project) — modo
 * "espelhamento automático": este pool só é usado por `pgMirror.ts` (e pelo script de validação
 * `scripts/validarEspelhamento.ts`) para manter o Postgres sincronizado como cópia fiel do
 * `dbStore` em memória. Nenhuma rota lê deste pool ainda — isso só acontece na Fase 3 (corte),
 * quando o Postgres vira a fonte de verdade de fato.
 *
 * Deliberadamente tolerante à ausência de configuração: em dev local, ou em produção antes do
 * Postgres ser provisionado no Easypanel, o pool simplesmente não é criado e o espelhamento vira
 * um no-op — o app continua funcionando 100% como antes, só em memória/arquivo.
 *
 * Duas formas de configurar a conexão (a primeira tem prioridade se as duas estiverem
 * presentes):
 *
 * 1. `DATABASE_URL` — uma única connection string (`postgres://usuario:senha@host:porta/banco`),
 *    formato usado pelo `docker-compose.prod.yml` e pela "Internal Connection URL" que o próprio
 *    Easypanel mostra na aba Credentials do serviço Postgres.
 * 2. `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_NAME` — variáveis separadas, para quem
 *    prefere configurar peça por peça em vez de montar a URL na mão. `DB_PORT` default 5432,
 *    `DB_NAME` default 'postgres' se não for definida.
 *
 * SSL (opcional, para provedores gerenciados que exigem mesmo em rede interna): `DATABASE_SSL`
 * ou `DB_SSL` igual a 'true'.
 */

let pool: Pool | null = null;
let poolInitAttempted = false;

export function isPgConfigured(): boolean {
  return !!process.env.DATABASE_URL || !!process.env.DB_HOST;
}

function buildPoolConfig(): PoolConfig {
  const useSsl = process.env.DATABASE_SSL === 'true' || process.env.DB_SSL === 'true';
  const ssl = useSsl ? { rejectUnauthorized: false } : undefined;

  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl, max: 5 };
  }

  return {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS,
    database: process.env.DB_NAME || 'postgres',
    ssl,
    max: 5
  };
}

export function getPgPool(): Pool | null {
  if (!isPgConfigured()) {
    return null;
  }

  if (!poolInitAttempted) {
    poolInitAttempted = true;
    pool = new Pool(buildPoolConfig());

    pool.on('error', (err) => {
      // Erro numa conexão ociosa do pool — não deve derrubar o processo.
      console.error('[pgPool] Erro inesperado numa conexão ociosa do pool Postgres:', err);
    });
  }

  return pool;
}
