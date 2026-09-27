import { dbStore } from './dbStore';
import { Tenant, Policy } from '../types';

/**
 * Inativação Agendada (pacote de 27/09, compartilhado pelo usuário) — quando `PUT
 * /admin/tenants/:id` recebe `status: 'INATIVO'` com uma `efetiva_em` futura, o cadastro
 * continua `ATIVO` até essa data chegar; só então `status` de fato vira `INATIVO`, puxando a
 * mesma cascata para CNPJs adicionais já usada na inativação imediata (pacote de 23/09).
 *
 * Sem job/cron no sistema — a efetivação é sempre preguiçosa, calculada na hora de ler ou usar o
 * tenant. Chamada em dois pontos: `GET /admin/tenants` (para a tela nunca mostrar um "Ativo"
 * defasado) e `AverbacaoService.process()` (para o bloqueio de fato valer numa averbação, mesmo
 * que ninguém tenha aberto a tela desde que a data passou).
 */
export function efetivarInativacaoProgramadaSeNecessaria(tenant: Tenant): void {
  if (!tenant.inativacao_programada_para) return;

  if (tenant.status === 'INATIVO') {
    // Já foi inativado por outro caminho (ex.: inativação imediata manual) — o agendamento
    // pendente perdeu o sentido, descarta.
    tenant.inativacao_programada_para = undefined;
    return;
  }

  if (new Date(tenant.inativacao_programada_para).getTime() > Date.now()) return; // ainda não chegou a data

  tenant.status = 'INATIVO';
  tenant.inativacao_programada_para = undefined;
  dbStore.tenantCnpjsAdicionais
    .filter((c) => c.tenant_id === tenant.id && c.status === 'ATIVO')
    .forEach((c) => {
      c.status = 'INATIVO';
    });
  dbStore.persist();
}

/** Mesmo cálculo de "apólice vigente agora" já usado em `calcularStatusCadastro`
 *  (adminPacote2109.ts) — ATIVA, dentro da vigência, e sem suspensão em vigor no momento. */
function estaVigente(p: Policy): boolean {
  const agora = Date.now();
  const suspensa =
    Boolean(p.suspensa_desde) &&
    new Date(p.suspensa_desde!).getTime() <= agora &&
    (!p.suspensa_ate || new Date(p.suspensa_ate).getTime() >= agora);
  return p.status === 'ATIVA' && !suspensa && new Date(p.vigencia_fim).getTime() >= agora;
}

/**
 * Inativação Automática por Ausência de Apólice Vigente (pacote de 27/09, compartilhado pelo
 * usuário) — decisão explícita do usuário, invertendo a causalidade que eu tinha proposto
 * (inativar o cadastro → encerrar apólices): "o segurado só é inativado quando ele não tiver
 * nenhuma apólice ativa". Ou seja, a inativação do cadastro é uma CONSEQUÊNCIA de nenhuma
 * apólice continuar vigente, não uma ação isolada que dispara o encerramento delas.
 *
 * Reaproveita o mesmo cálculo de "vigente agora" de `calcularStatusCadastro` — que já expõe essa
 * mesma condição como a categoria de exibição `SEM_APOLICES_VIGENTES`; esta função é o que torna
 * esse estado REAL (persiste em `Tenant.status`), não só uma categoria calculada pra tela.
 *
 * Calculada de forma preguiçosa (sem job/cron), no mesmo padrão de
 * `efetivarInativacaoProgramadaSeNecessaria` — chamada em `GET /admin/tenants` e no motor de
 * averbação. Nunca reativa automaticamente (só INATIVO é derivado; reativar continua sendo
 * sempre uma ação explícita do ADM/seguradora, ex.: ao cadastrar uma apólice nova) e nunca
 * inativa um cadastro que ainda não tem nenhuma apólice (cadastro recém-criado, antes da
 * primeira apólice ser vinculada — mesmo tratamento de `SEM_APOLICES_VIGENTES` vs `INATIVO` já
 * usado em `calcularStatusCadastro`).
 */
export function sincronizarStatusCadastroSeNecessario(tenant: Tenant, apolicesDoTenant: Policy[]): void {
  if (tenant.status === 'INATIVO') return; // já inativo — nada a fazer
  if (apolicesDoTenant.length === 0) return; // cadastro sem nenhuma apólice ainda — não inativa

  const temApoliceVigente = apolicesDoTenant.some(estaVigente);
  if (temApoliceVigente) return;

  tenant.status = 'INATIVO';
  tenant.inativacao_programada_para = undefined; // qualquer agendamento pendente perde o sentido
  dbStore.tenantCnpjsAdicionais
    .filter((c) => c.tenant_id === tenant.id && c.status === 'ATIVO')
    .forEach((c) => {
      c.status = 'INATIVO';
    });
  dbStore.persist();
}
