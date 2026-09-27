import { dbStore } from './dbStore';
import { Tenant } from '../types';

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
 *
 * Fora de escopo desta rodada, por decisão registrada no mapeamento de 27/09 (Portal da
 * Seguradora): encerrar automaticamente as apólices do cadastro quando a inativação (imediata ou
 * agendada) se efetiva. O frontend já espera esse comportamento, mas mudar `Policy.vigencia_fim`
 * sozinho é uma mudança financeira/de cobertura grande demais para decidir sem confirmação
 * explícita — fica como próximo passo, não implementado aqui.
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
