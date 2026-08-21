/* eslint-disable no-console */
import dotenv from 'dotenv';
import { dbStore } from '../src/services/dbStore';
import { mirrorToPostgres, ENTITY_CONFIGS } from '../src/services/pgMirror';
import { getPgPool, isPgConfigured } from '../src/services/pgPool';

dotenv.config();

/**
 * Backfill inicial (ver claude/Plano_Migracao_Postgres.md no Project) — resolve o cenário em que
 * `npm run validate:mirror` mostra pg=0 em praticamente todas as tabelas, mesmo com o Postgres já
 * configurado e as migrations já aplicadas (`npm run migrate:up`).
 *
 * Motivo: `mirrorToPostgres()` (Fase 1, `pgMirror.ts`) só é disparado quando `dbStore.persist()`
 * roda — ou seja, a cada escrita nova (criar/editar tenant, apólice, averbação etc). Dados que já
 * existiam no `data_store.json` ANTES do Postgres ser configurado nunca disparam esse gatilho
 * sozinhos, então continuam de fora do Postgres até a primeira escrita nova acontecer em cada
 * tabela — o que pode nunca acontecer para tabelas mais estáveis (ex: tenants, apólices antigas).
 *
 * Este script resolve isso com UMA passagem manual: carrega o `data_store.json` atual (mesmo
 * carregamento usado pelo servidor, via `dbStore`) e chama `mirrorToPostgres()` diretamente uma
 * única vez, copiando o estado inteiro pro Postgres imediatamente — sem esperar por uma escrita
 * nova. É seguro rodar mais de uma vez (upsert por id, não duplica nada) e não apaga nada que já
 * esteja correto no Postgres.
 *
 * Uso (mesmas variáveis de ambiente do serviço em produção):
 *
 *   DATABASE_URL="postgres://..." DATA_DIR="/app/storage" npm run sync:inicial
 *
 * (ou DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME em vez de DATABASE_URL — ver `pgPool.ts`.)
 *
 * Depois de rodar este script, rode `npm run validate:mirror` para confirmar que bateu tudo.
 */

async function main() {
  if (!isPgConfigured()) {
    console.error(
      '[sincronizar-inicial] Nenhuma configuração de banco encontrada (defina DATABASE_URL, ou ' +
        'DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME) e rode de novo.'
    );
    process.exit(1);
  }

  console.log('[sincronizar-inicial] Copiando o estado atual do data_store.json para o Postgres...');
  console.log(`[sincronizar-inicial] ${ENTITY_CONFIGS.length} tabelas serão sincronizadas.\n`);

  for (const config of ENTITY_CONFIGS) {
    const rows = (dbStore as unknown as Record<string, any[]>)[config.storeKey] || [];
    console.log(`  - ${config.table.padEnd(28)} ${rows.length} linha(s) no JSON`);
  }

  await mirrorToPostgres(dbStore as unknown as Record<string, any>);

  const pool = getPgPool();
  if (pool) {
    await pool.end();
  }

  console.log(
    '\n✅ Sincronização inicial concluída. Rode "npm run validate:mirror" para confirmar que bateu tudo.'
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[sincronizar-inicial] Erro inesperado:', err);
  process.exit(1);
});
