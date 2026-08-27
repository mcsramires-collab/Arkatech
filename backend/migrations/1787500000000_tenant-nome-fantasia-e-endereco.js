/* eslint-disable camelcase */

/**
 * Rodada de correções da auditoria de integração real de 27/08 (ver claude/Backlog_Proximos_Passos.md
 * no Project) — o wizard "Novo Cadastro de Segurados" do Portal da Seguradora já coleta nome
 * fantasia e endereço completo (Etapa 2), mas esses campos eram descartados no envio: `Tenant`
 * nunca teve colunas para guardá-los. `vigencia_inicio`/`vigencia_fim` (Etapa 4) já eram
 * persistidos de verdade em `Policy` — não precisaram de mudança.
 *
 * Mesma regra das migrations anteriores: isto só desenha o schema, espelhado pelo `pgMirror.ts`
 * — nenhuma rota lê/escreve direto no Postgres ainda.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('tenants', {
    nome_fantasia: { type: 'text' },
    logradouro: { type: 'text' },
    numero_endereco: { type: 'text' },
    bairro: { type: 'text' },
    cidade: { type: 'text' },
    uf: { type: 'varchar(2)' },
    cep: { type: 'varchar(9)' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('tenants', [
    'nome_fantasia',
    'logradouro',
    'numero_endereco',
    'bairro',
    'cidade',
    'uf',
    'cep'
  ]);
};
