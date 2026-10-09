import { dbStore } from './dbStore';

const TIMEZONE = 'America/Sao_Paulo';
const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit' });

function monthKey(date: Date): string {
  const parts = monthFormatter.formatToParts(date);
  return `${parts.find((part) => part.type === 'year')!.value.padStart(4, '0')}-${parts.find((part) => part.type === 'month')!.value}`;
}

export function validDashboardMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0;
}

function previousMonth(value: string): string {
  const [year, month] = value.split('-').map(Number);
  return month === 1 ? `${String(year - 1).padStart(4, '0')}-12` : `${String(year).padStart(4, '0')}-${String(month - 1).padStart(2, '0')}`;
}

function comparison(current: number, previous: number): { value: number; direction: 'up' | 'down' } {
  if (previous === 0) return { value: current === 0 ? 0 : 100, direction: 'up' };
  const change = ((current - previous) / previous) * 100;
  return { value: Math.round(Math.abs(change)), direction: change >= 0 ? 'up' : 'down' };
}

/** Read-only monthly projection. Queues deliberately describe the current state, not history. */
export function tenantDashboardStats(tenantId: string, requestedMonth?: string, now = new Date()) {
  const month = requestedMonth ?? monthKey(now);
  if (!validDashboardMonth(month)) throw new Error('INVALID_DASHBOARD_MONTH');
  const previous = previousMonth(month);
  const nowMs = now.getTime();
  const records = dbStore.averbacoes
    .filter((item) => item.tenant_id === tenantId)
    .map((item) => ({ item, timestamp: Date.parse(item.created_at) }))
    .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp <= nowMs)
    .map(({ item, timestamp }) => ({ item, timestamp, month: monthKey(new Date(timestamp)) }));

  const selected = records.filter((record) => record.month === month);
  const prior = records.filter((record) => record.month === previous);
  const successes = selected.filter(({ item }) => item.status === 'SUCESSO');
  const previousSuccesses = prior.filter(({ item }) => item.status === 'SUCESSO');
  const refused = selected.filter(({ item }) => item.status === 'ERRO');
  const previousRefused = prior.filter(({ item }) => item.status === 'ERRO');
  const sum = (items: typeof records) => items.reduce((total, { item }) => {
    const value = item.valor_considerado_averbacao;
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  const latest = [...successes]
    .sort((a, b) => b.timestamp - a.timestamp || a.item.id.localeCompare(b.item.id))
    .slice(0, 5)
    .map(({ item }) => {
      const policy = dbStore.policies.find((candidate) => candidate.id === item.policy_id && candidate.tenant_id === tenantId);
      // Explicit projection: do not expose XML, recovery tokens or unrelated policy fields.
      return {
        id: item.id,
        numero_averbacao: item.numero_averbacao,
        status: item.status,
        tipo_documento: item.tipo_documento,
        chave_documento: item.chave_documento,
        valor_considerado_averbacao: item.valor_considerado_averbacao,
        created_at: item.created_at,
        numero_documento: item.numero_documento,
        serie_documento: item.serie_documento,
        cnpj_emissor: item.cnpj_emissor,
        cnpj_remetente: item.cnpj_remetente,
        cnpj_destinatario: item.cnpj_destinatario,
        cnpj_tomador: item.cnpj_tomador,
        ramo: policy?.ramo
      };
    });

  return {
    periodo: { mes: month, mes_anterior: previous, timezone: TIMEZONE, escopo_pendencias: 'ATUAL' as const },
    total_averbacoes: successes.length,
    total_recusadas: refused.length,
    total_pendentes_recuperacao: dbStore.recoverySessions.filter((item) =>
      item.tenant_id === tenantId && !item.utilizada && Date.parse(item.expira_em) > nowMs
    ).length,
    valor_total_averbado: sum(successes),
    solicitacoes_regras_pendentes: dbStore.businessRuleRequests.filter((item) =>
      item.tenant_id === tenantId && item.status === 'PENDENTE'
    ).length,
    comparacoes: {
      averbacoes: comparison(successes.length, previousSuccesses.length),
      recusadas: comparison(refused.length, previousRefused.length),
      valor_total_averbado: comparison(sum(successes), sum(previousSuccesses))
    },
    alertas: [],
    ultimas_averbacoes: latest
  };
}
