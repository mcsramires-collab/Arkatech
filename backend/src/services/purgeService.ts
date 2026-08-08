import { dbStore } from './dbStore';

export class PurgeService {
  /**
   * Remove registros de averbações e XMLs brutos de clientes no ambiente de 'teste' criados há mais de X dias.
   */
  public static purgeTestData(daysToKeep: number = 30): { averbacoesRemovidas: number } {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const testTenantIds = dbStore.tenants
      .filter((t) => t.ambiente === 'teste')
      .map((t) => t.id);

    const initialLength = dbStore.averbacoes.length;

    dbStore.averbacoes = dbStore.averbacoes.filter((a) => {
      if (!testTenantIds.includes(a.tenant_id)) return true; // Manter produção intacta
      const created = new Date(a.created_at);
      return created >= cutoffDate;
    });

    const averbacoesRemovidas = initialLength - dbStore.averbacoes.length;

    dbStore.persist();

    return { averbacoesRemovidas };
  }
}
