import { PoolClient } from 'pg';
import { getPgPool, isPgConfigured } from './pgPool';

/**
 * Fase 1 da migração para Postgres — modo "espelhamento automático" (ver
 * claude/Plano_Migracao_Postgres.md no Project).
 *
 * Em vez de reescrever as 130+ chamadas que hoje mexem direto nos arrays do `dbStore`
 * (`dbStore.policies.push(...)`, `.find(...)`, `.splice(...)` etc. espalhadas por `admin.ts`,
 * `tenant.ts`, `broker.ts`, `averbacao.ts`...), este módulo espelha o estado ATUAL de todos os
 * arrays do `dbStore` para o Postgres toda vez que `dbStore.persist()` é chamado (debounced, ver
 * `scheduleMirror` em `dbStore.ts`). Nenhuma rota é tocada nesta fase — o Postgres passa a ser
 * uma cópia fiel e sempre atualizada do que já está em memória, sem risco de o app quebrar (se o
 * Postgres cair ou não estiver configurado, o espelhamento vira um no-op silencioso, logado, e o
 * app continua 100% funcional do jeito atual).
 *
 * A troca de verdade — rotas lendo/escrevendo direto no Postgres — fica pra Fase 3 (corte), que
 * só acontece depois que a Fase 2 (migração do dado real de produção) validar que este
 * espelhamento está funcionando de ponta a ponta.
 */

export interface EntityMirrorConfig {
  table: string;
  /** Nome da propriedade correspondente em `dbStore` (ex: 'policyRules' -> tabela policy_rules). */
  storeKey: string;
  pk: string;
  columns: string[];
  jsonbColumns?: string[];
}

// Ordem de dependência (pai antes de filho) — mesma ordem usada na migration
// `1787257248207_init-schema.js`. Upserts rodam nesta ordem; deletes rodam na ordem inversa.
// Exportada para ser reutilizada pelo script de validação da Fase 2
// (`scripts/validarEspelhamento.ts`) — uma única fonte de verdade para o mapeamento
// entidade -> tabela/colunas, em vez de duplicar essa lista em dois lugares.
export const ENTITY_CONFIGS: EntityMirrorConfig[] = [
  {
    table: 'tenants',
    storeKey: 'tenants',
    pk: 'id',
    columns: [
      'id', 'cnpj', 'razao_social', 'status', 'ambiente', 'client_id', 'client_secret_hash',
      'role', 'token_duration_hours', 'created_at', 'contato_nome', 'contato_email',
      'contato_telefone_fixo', 'contato_celular', 'conta_ativada'
    ]
  },
  {
    table: 'insurers',
    storeKey: 'insurers',
    pk: 'id',
    columns: ['id', 'tenant_id', 'cnpj', 'nome', 'razao_social', 'nome_fantasia', 'created_at']
  },
  {
    table: 'brokers',
    storeKey: 'brokers',
    pk: 'id',
    columns: [
      'id', 'tenant_id', 'cnpj', 'nome', 'razao_social', 'nome_fantasia',
      'corretor_responsavel_nome', 'corretor_responsavel_email',
      'corretor_responsavel_telefone_fixo', 'corretor_responsavel_celular', 'created_at'
    ]
  },
  {
    table: 'rbac_profiles',
    storeKey: 'rbacProfiles',
    pk: 'id',
    columns: ['id', 'owner_type', 'owner_id', 'nome_perfil', 'permissions', 'created_at'],
    jsonbColumns: ['permissions']
  },
  {
    table: 'internal_users',
    storeKey: 'internalUsers',
    pk: 'id',
    columns: ['id', 'nome', 'email', 'password_hash', 'role', 'rbac_profile_id', 'status', 'created_at']
  },
  {
    table: 'tenant_users',
    storeKey: 'tenantUsers',
    pk: 'id',
    columns: [
      'id', 'tenant_id', 'nome', 'email', 'password_hash', 'rbac_profile_id',
      'is_admin_da_conta', 'status', 'created_at'
    ]
  },
  {
    table: 'policies',
    storeKey: 'policies',
    pk: 'id',
    columns: [
      'id', 'numero_apolice', 'ramo', 'tenant_id', 'insurer_id', 'broker_id', 'co_broker_id',
      'assessoria_id', 'status', 'permitir_inativo_vencido', 'vigencia_inicio', 'vigencia_fim',
      'lmi', 'aceita_averbacao_como_destinatario'
    ]
  },
  {
    table: 'policy_titularity_rules',
    storeKey: 'policyTitularityRules',
    pk: 'id',
    columns: ['id', 'policy_id', 'funcao', 'habilitada']
  },
  {
    table: 'policy_bypass_rules',
    storeKey: 'policyBypassRules',
    pk: 'id',
    columns: ['id', 'policy_id', 'rota_uf_origem', 'rota_uf_destino', 'produto_predominante']
  },
  {
    table: 'policy_rules',
    storeKey: 'policyRules',
    pk: 'id',
    columns: [
      'id', 'policy_id', 'tipo_doc', 'tag_path', 'nome_variavel', 'obrigatoria',
      'exemplo_preenchimento', 'instrucao_recuperacao'
    ]
  },
  {
    table: 'document_rules',
    storeKey: 'documentRules',
    pk: 'id',
    columns: [
      'id', 'tipo_documento', 'tag_path', 'nome_variavel', 'obrigatoria', 'origem',
      'observacao', 'created_at'
    ]
  },
  {
    table: 'response_templates',
    storeKey: 'responseTemplates',
    pk: 'id',
    columns: [
      'id', 'codigo', 'tipo', 'categoria', 'texto_padrao', 'texto_customizado', 'placeholders',
      'explicacao_nao_tecnica', 'orientacao_correcao', 'updated_at'
    ]
  },
  {
    table: 'raw_xml_store',
    storeKey: 'rawXmlStore',
    pk: 'id',
    columns: ['id', 'content_xml', 'hash_sha256', 'encrypted_aes256', 'created_at']
  },
  {
    table: 'averbacoes',
    storeKey: 'averbacoes',
    pk: 'id',
    columns: [
      'id', 'numero_averbacao', 'protocolo_interno_averbacao', 'tenant_id', 'policy_id',
      'status', 'codigo_resposta', 'mensagem_resposta', 'valor_carga',
      'valor_considerado_averbacao', 'regras_internas_aplicadas', 'tp_amb_sefaz',
      'tipo_documento', 'chave_documento', 'numero_documento', 'serie_documento',
      'cnpj_remetente', 'cnpj_destinatario', 'cnpj_tomador', 'protocolo_aceitacao_sefaz',
      'raw_xml_id', 'recovery_token', 'ambiente', 'timestamp', 'created_at'
    ]
  },
  {
    table: 'recovery_sessions',
    storeKey: 'recoverySessions',
    pk: 'token',
    columns: [
      'token', 'tenant_id', 'policy_id', 'tipo_documento', 'raw_xml_content',
      'variaveis_faltantes', 'expira_em', 'utilizada', 'created_at'
    ]
  },
  {
    table: 'batch_test_runs',
    storeKey: 'batchTestRuns',
    pk: 'id',
    columns: [
      'id', 'total_docs', 'distribuicao', 'status', 'configuracao_clientes',
      'metricas_globais', 'metricas_por_cliente', 'created_at'
    ],
    jsonbColumns: ['configuracao_clientes', 'metricas_globais', 'metricas_por_cliente']
  },
  {
    table: 'insurer_coverage_templates',
    storeKey: 'insurerCoverageTemplates',
    pk: 'id',
    columns: ['id', 'titulo', 'ativo', 'created_at']
  },
  {
    table: 'insurer_coverages',
    storeKey: 'insurerCoverages',
    pk: 'id',
    columns: [
      'id', 'insurer_id', 'ramo', 'titulo', 'exemplo_preenchimento', 'obrigatoria',
      'aplicar_todos_clientes', 'tenant_id', 'tipo_valor', 'created_at'
    ]
  },
  {
    table: 'delegation_permissions',
    storeKey: 'delegationPermissions',
    pk: 'id',
    columns: ['id', 'insurer_id', 'broker_id', 'action', 'requires_approval']
  },
  {
    table: 'approval_requests',
    storeKey: 'approvalRequests',
    pk: 'id',
    columns: [
      'id', 'insurer_id', 'broker_id', 'action', 'payload', 'status', 'created_at',
      'resolved_at', 'resolved_by'
    ],
    jsonbColumns: ['payload']
  },
  {
    table: 'activation_tokens',
    storeKey: 'activationTokens',
    pk: 'id',
    columns: [
      'id', 'tenant_id', 'token', 'termo_versao', 'aceite', 'aceite_em', 'expira_em', 'created_at'
    ]
  },
  {
    table: 'notification_preferences',
    storeKey: 'notificationPreferences',
    pk: 'id',
    columns: ['id', 'tenant_user_id', 'canal', 'ativo']
  },
  {
    table: 'business_rule_requests',
    storeKey: 'businessRuleRequests',
    pk: 'id',
    columns: [
      'id', 'tenant_id', 'tipo', 'descricao', 'status', 'solicitante_nome',
      'comentario_seguradora', 'created_at', 'resolved_at'
    ]
  }
];

const CHUNK_SIZE = 200; // linhas por INSERT multi-linha, margem confortável abaixo do limite de params do Postgres

function extractValue(row: any, column: string, jsonbColumns: string[] | undefined): any {
  const raw = row[column];
  if (raw === undefined) return null;
  if (jsonbColumns && jsonbColumns.includes(column)) {
    return raw === null ? null : JSON.stringify(raw);
  }
  return raw;
}

async function upsertEntity(client: PoolClient, config: EntityMirrorConfig, rows: any[]): Promise<void> {
  if (rows.length === 0) return;

  const nonPkColumns = config.columns.filter((c) => c !== config.pk);
  const updateSet = nonPkColumns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);
    const values: any[] = [];
    const rowPlaceholders: string[] = [];

    chunk.forEach((row, rowIdx) => {
      const placeholders = config.columns.map((col) => {
        values.push(extractValue(row, col, config.jsonbColumns));
        return `$${values.length}`;
      });
      rowPlaceholders.push(`(${placeholders.join(', ')})`);
      void rowIdx;
    });

    const columnList = config.columns.map((c) => `"${c}"`).join(', ');
    const sql =
      updateSet.length > 0
        ? `INSERT INTO "${config.table}" (${columnList}) VALUES ${rowPlaceholders.join(', ')} ` +
          `ON CONFLICT ("${config.pk}") DO UPDATE SET ${updateSet}`
        : `INSERT INTO "${config.table}" (${columnList}) VALUES ${rowPlaceholders.join(', ')} ` +
          `ON CONFLICT ("${config.pk}") DO NOTHING`;

    await client.query(sql, values);
  }
}

async function deleteMissing(client: PoolClient, config: EntityMirrorConfig, rows: any[]): Promise<void> {
  const currentIds = rows.map((r) => r[config.pk]).filter((v) => v !== undefined && v !== null);

  if (currentIds.length === 0) {
    await client.query(`DELETE FROM "${config.table}"`);
    return;
  }

  await client.query(
    `DELETE FROM "${config.table}" WHERE NOT ("${config.pk}" = ANY($1::text[]))`,
    [currentIds]
  );
}

let mirrorInFlight = false;
let mirrorPendingRerun = false;

/**
 * Espelha o estado atual de todos os arrays de `store` (a instância do `DBStore`) para o
 * Postgres, dentro de uma única transação. Recebe a instância por parâmetro (em vez de importar
 * `dbStore` diretamente) só para evitar um import circular com `dbStore.ts`, que é quem chama
 * esta função a partir de `persist()`.
 *
 * Idempotente e seguro de chamar mesmo com Postgres não configurado (no-op) ou temporariamente
 * fora do ar (loga o erro, não propaga — nunca derruba quem chamou).
 */
export async function mirrorToPostgres(store: Record<string, any>): Promise<void> {
  if (!isPgConfigured()) return;

  // Evita rodar duas passagens de espelhamento concorrentes (podem colidir/duplicar trabalho);
  // se chegou uma chamada nova enquanto uma já estava em andamento, agenda mais uma passagem
  // logo depois, para não perder a mudança mais recente.
  if (mirrorInFlight) {
    mirrorPendingRerun = true;
    return;
  }
  mirrorInFlight = true;

  const pool = getPgPool();
  if (!pool) {
    mirrorInFlight = false;
    return;
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    for (const config of ENTITY_CONFIGS) {
      const rows = (store[config.storeKey] || []) as any[];
      await upsertEntity(client, config, rows);
    }
    for (const config of [...ENTITY_CONFIGS].reverse()) {
      const rows = (store[config.storeKey] || []) as any[];
      await deleteMissing(client, config, rows);
    }

    await client.query('COMMIT');
  } catch (err) {
    console.error('[pgMirror] Falha ao espelhar dbStore para o Postgres:', err);
    try {
      if (client) await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[pgMirror] Falha ao fazer rollback:', rollbackErr);
    }
  } finally {
    if (client) client.release();
    mirrorInFlight = false;
    if (mirrorPendingRerun) {
      mirrorPendingRerun = false;
      // Não aguardamos essa nova passagem — é fire-and-forget, igual à chamada original.
      void mirrorToPostgres(store);
    }
  }
}
