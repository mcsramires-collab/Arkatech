/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { ENTITY_CONFIGS, EntityMirrorConfig } from '../src/services/pgMirror';

dotenv.config();

/**
 * Fase 2 da migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project) —
 * validação do espelhamento automático introduzido na Fase 1 (PR #13).
 *
 * Não migra nada e não escreve em lugar nenhum — só LÊ o `data_store.json` atual e o Postgres
 * espelhado, e compara os dois lado a lado, tabela por tabela e linha por linha. Uso:
 *
 *   DATABASE_URL="postgres://..." DATA_DIR="/app/storage" npm run validate:mirror
 *
 * Rode com as MESMAS variáveis de ambiente do serviço `apiarcka` em produção (mesma DATA_DIR,
 * mesma DATABASE_URL), pra comparar o JSON e o Postgres reais — não os de um ambiente local.
 * Sai com código 0 se tudo bater, ou 1 se encontrar qualquer divergência (linhas faltando de um
 * lado ou do outro, ou campos com valor diferente entre o JSON e o Postgres).
 */

const filePath = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..'),
  'data_store.json'
);

// Mapeia storeKey (camelCase, como salvo no data_store.json) -> array de linhas daquela entidade.
function loadJsonStore(): Record<string, any[]> {
  if (!fs.existsSync(filePath)) {
    console.error(`[validar-espelhamento] Não encontrei o arquivo esperado: ${filePath}`);
    console.error('Confira se DATA_DIR está apontando para o mesmo volume usado em produção.');
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

// Normaliza um valor do Postgres para poder comparar com o valor equivalente vindo do JSON —
// sem isso, diferenças puramente de REPRESENTAÇÃO (Date vs string ISO, numeric como string vs
// number, chave de objeto em outra ordem) apareceriam como falsos positivos.
function normalize(value: any): any {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, any> = {};
    for (const k of sortedKeys) out[k] = normalize(value[k]);
    return out;
  }
  return value;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function valuesEqual(jsonVal: any, pgVal: any): boolean {
  const nJson = normalize(jsonVal);
  const nPg = normalize(pgVal);

  // numeric/decimal do Postgres volta como string (pg não converte pra evitar perda de precisão);
  // o JSON guarda number. Compara numericamente quando os dois parecem número.
  if (
    typeof nPg === 'string' &&
    typeof nJson === 'number' &&
    !Number.isNaN(Number(nPg))
  ) {
    return Number(nPg) === nJson;
  }

  // Datas: o JSON guarda o ISO string original (às vezes sem milissegundos, ex: "...:00Z"), e o
  // Postgres sempre devolve com milissegundos (ex: "...:00.000Z") depois da conversão de Date
  // pra ISO em normalize(). São o mesmo instante — compara por epoch, não pela string exata.
  if (
    typeof nJson === 'string' &&
    typeof nPg === 'string' &&
    ISO_DATE_RE.test(nJson) &&
    ISO_DATE_RE.test(nPg)
  ) {
    return new Date(nJson).getTime() === new Date(nPg).getTime();
  }

  return JSON.stringify(nJson) === JSON.stringify(nPg);
}

interface TableReport {
  table: string;
  jsonCount: number;
  pgCount: number;
  missingInPg: string[];
  missingInJson: string[];
  fieldMismatches: { id: string; field: string; jsonValue: any; pgValue: any }[];
}

async function validateTable(
  pool: Pool,
  config: EntityMirrorConfig,
  jsonRows: any[]
): Promise<TableReport> {
  const jsonById = new Map<string, any>();
  for (const row of jsonRows) jsonById.set(String(row[config.pk]), row);

  const { rows: pgRows } = await pool.query(`SELECT * FROM "${config.table}"`);
  const pgById = new Map<string, any>();
  for (const row of pgRows) pgById.set(String(row[config.pk]), row);

  const missingInPg = [...jsonById.keys()].filter((id) => !pgById.has(id));
  const missingInJson = [...pgById.keys()].filter((id) => !jsonById.has(id));

  const fieldMismatches: TableReport['fieldMismatches'] = [];
  for (const [id, jsonRow] of jsonById) {
    const pgRow = pgById.get(id);
    if (!pgRow) continue; // já reportado em missingInPg
    for (const col of config.columns) {
      if (!valuesEqual(jsonRow[col], pgRow[col])) {
        fieldMismatches.push({ id, field: col, jsonValue: jsonRow[col], pgValue: pgRow[col] });
      }
    }
  }

  return {
    table: config.table,
    jsonCount: jsonRows.length,
    pgCount: pgRows.length,
    missingInPg,
    missingInJson,
    fieldMismatches
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[validar-espelhamento] DATABASE_URL não configurada. Defina-a e rode de novo.');
    process.exit(1);
  }

  const jsonStore = loadJsonStore();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  console.log(`[validar-espelhamento] Lendo dado real de: ${filePath}`);
  console.log(`[validar-espelhamento] Comparando ${ENTITY_CONFIGS.length} tabelas...\n`);

  const reports: TableReport[] = [];
  for (const config of ENTITY_CONFIGS) {
    const jsonRows = jsonStore[config.storeKey] || [];
    const report = await validateTable(pool, config, jsonRows);
    reports.push(report);

    const ok =
      report.missingInPg.length === 0 &&
      report.missingInJson.length === 0 &&
      report.fieldMismatches.length === 0;

    const status = ok ? 'OK   ' : 'FALHA';
    console.log(
      `[${status}] ${config.table.padEnd(28)} json=${report.jsonCount} pg=${report.pgCount}` +
        (ok ? '' : `  <-- ver detalhes abaixo`)
    );
  }

  await pool.end();

  const withProblems = reports.filter(
    (r) => r.missingInPg.length > 0 || r.missingInJson.length > 0 || r.fieldMismatches.length > 0
  );

  if (withProblems.length === 0) {
    console.log('\n✅ Tudo bateu — Postgres espelhado é idêntico ao data_store.json em todas as tabelas.');
    process.exit(0);
  }

  console.log(`\n❌ ${withProblems.length} tabela(s) com divergência:\n`);
  for (const r of withProblems) {
    console.log(`--- ${r.table} ---`);
    if (r.missingInPg.length > 0) {
      console.log(`  Faltando no Postgres (${r.missingInPg.length}): ${r.missingInPg.slice(0, 10).join(', ')}${r.missingInPg.length > 10 ? ', ...' : ''}`);
    }
    if (r.missingInJson.length > 0) {
      console.log(`  Sobrando no Postgres, ausentes do JSON (${r.missingInJson.length}): ${r.missingInJson.slice(0, 10).join(', ')}${r.missingInJson.length > 10 ? ', ...' : ''}`);
    }
    if (r.fieldMismatches.length > 0) {
      console.log(`  Campos divergentes (${r.fieldMismatches.length}), primeiros 10:`);
      for (const m of r.fieldMismatches.slice(0, 10)) {
        console.log(`    id=${m.id} campo=${m.field} json=${JSON.stringify(m.jsonValue)} pg=${JSON.stringify(m.pgValue)}`);
      }
    }
    console.log('');
  }

  process.exit(1);
}

main().catch((err) => {
  console.error('[validar-espelhamento] Erro inesperado:', err);
  process.exit(1);
});
