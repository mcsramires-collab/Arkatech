import { dbStore } from './dbStore';
import { Averbacao, Policy } from '../types';

export interface InsurerAverbacaoFilters {
  tenant_id?: string;
  status?: string;
  tipo_documento?: string;
  data_de?: string;
  data_ate?: string;
}

export class InsurerVisibilityService {
  static policies(insurerId: string, tenantId?: string): Policy[] {
    return dbStore.policies.filter(
      (policy) =>
        policy.insurer_id === insurerId &&
        (!tenantId || policy.tenant_id === tenantId)
    );
  }

  static policyIds(insurerId: string, tenantId?: string): Set<string> {
    return new Set(this.policies(insurerId, tenantId).map((policy) => policy.id));
  }

  static canAccessPolicy(insurerId: string, policyId: string): boolean {
    return dbStore.policies.some(
      (policy) => policy.id === policyId && policy.insurer_id === insurerId
    );
  }

  static canAccessAverbacao(insurerId: string, averbacaoId: string): boolean {
    const averbacao = dbStore.averbacoes.find((item) => item.id === averbacaoId);
    return Boolean(
      averbacao && this.canAccessPolicy(insurerId, averbacao.policy_id)
    );
  }

  static averbacoes(
    insurerId: string,
    filters: InsurerAverbacaoFilters = {}
  ): Averbacao[] {
    const policyIds = this.policyIds(insurerId, filters.tenant_id);
    let items = dbStore.averbacoes.filter((item) => policyIds.has(item.policy_id));

    if (filters.status) {
      const status = filters.status.toUpperCase();
      items = items.filter((item) => item.status === status);
    }

    if (filters.tipo_documento) {
      const tipo = filters.tipo_documento.toUpperCase();
      items = items.filter((item) => item.tipo_documento === tipo);
    }

    if (filters.data_de) {
      const from = new Date(filters.data_de);
      if (!Number.isNaN(from.getTime())) {
        items = items.filter((item) => new Date(item.created_at) >= from);
      }
    }

    if (filters.data_ate) {
      const to = new Date(filters.data_ate);
      if (!Number.isNaN(to.getTime())) {
        items = items.filter((item) => new Date(item.created_at) <= to);
      }
    }

    return [...items].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  static aggregate(insurerId: string) {
    const policies = this.policies(insurerId);
    const policyIds = new Set(policies.map((policy) => policy.id));
    const tenantIds = new Set(policies.map((policy) => policy.tenant_id));
    const averbacoes = dbStore.averbacoes.filter((item) => policyIds.has(item.policy_id));
    const sucesso = averbacoes.filter((item) => item.status === 'SUCESSO');
    const erro = averbacoes.filter((item) => item.status === 'ERRO');
    const pendente = averbacoes.filter((item) => item.status === 'PENDENTE_APROVACAO');

    return {
      insurer_id: insurerId,
      policy_ids: [...policyIds],
      tenant_ids: [...tenantIds],
      total_policies: policies.length,
      total_tenants: tenantIds.size,
      total_averbacoes: averbacoes.length,
      total_sucesso: sucesso.length,
      total_erro: erro.length,
      total_pendente: pendente.length,
      valor_total_averbado: sucesso.reduce(
        (sum, item) => sum + (item.valor_considerado_averbacao ?? item.valor_carga ?? 0),
        0
      )
    };
  }
}
