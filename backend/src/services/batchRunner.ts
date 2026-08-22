import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import { BatchTestRun, RamoApolice } from '../types';
import { MockGeneratorService } from './mockGenerator';
import { AverbacaoService } from './averbacao';

export interface BatchTestRequestDTO {
  distribuicao: 'ROUND_ROBIN' | 'CUSTOM';
  total_docs?: number;
  configuracao_clientes: { tenant_id: string; quantidade?: number }[];
  ramo?: RamoApolice;
}

export class BatchRunnerService {
  /**
   * Executa a simulação em lote multi-cliente em alta performance e calcula métricas globais e por cliente.
   */
  public static async executeBatch(dto: BatchTestRequestDTO): Promise<BatchTestRun> {
    const startTime = Date.now();
    const ramo = dto.ramo || 'RCTRC';

    // 1. Validar Clientes Selecionados
    const clientsConfigs: { tenant_id: string; quantidade: number }[] = [];
    const validTenants = [];

    for (const cfg of dto.configuracao_clientes) {
      const tenant = dbStore.tenants.find((t) => t.id === cfg.tenant_id);
      if (tenant && tenant.ambiente === 'teste') {
        validTenants.push(tenant);
      }
    }

    if (validTenants.length === 0) {
      throw new Error('Nenhum cliente válido do ambiente de TESTE foi selecionado.');
    }

    // 2. Calcular distribuição de quantidade por cliente
    if (dto.distribuicao === 'ROUND_ROBIN') {
      const totalDocs = dto.total_docs || 100;
      const basePerClient = Math.floor(totalDocs / validTenants.length);
      const remainder = totalDocs % validTenants.length;

      validTenants.forEach((t, index) => {
        const qty = basePerClient + (index < remainder ? 1 : 0);
        clientsConfigs.push({ tenant_id: t.id, quantidade: qty });
      });
    } else {
      // CUSTOM
      for (const cfg of dto.configuracao_clientes) {
        const tenant = validTenants.find((t) => t.id === cfg.tenant_id);
        if (tenant) {
          clientsConfigs.push({ tenant_id: tenant.id, quantidade: cfg.quantidade || 10 });
        }
      }
    }

    const totalCalculado = clientsConfigs.reduce((acc, c) => acc + c.quantidade, 0);

    // Inicializar Registro de Teste
    const batchRun: BatchTestRun = {
      id: uuidv4(),
      total_docs: totalCalculado,
      distribuicao: dto.distribuicao,
      status: 'PROCESSANDO',
      configuracao_clientes: clientsConfigs,
      metricas_globais: {
        total: 0,
        sucessos: 0,
        erros: 0,
        tempo_total_ms: 0,
        throughput_docs_sec: 0
      },
      metricas_por_cliente: {},
      created_at: new Date().toISOString()
    };

    // Inicializar estruturas de métricas por cliente
    for (const cfg of clientsConfigs) {
      const tenant = validTenants.find((t) => t.id === cfg.tenant_id)!;
      batchRun.metricas_por_cliente[cfg.tenant_id] = {
        cnpj: tenant.cnpj,
        razao_social: tenant.razao_social,
        total: 0,
        sucessos: 0,
        erros: 0,
        tempo_medio_ms: 0
      };
    }

    dbStore.batchTestRuns.unshift(batchRun);

    // 3. Execução dos Documentos
    let globalSucessos = 0;
    let globalErros = 0;

    for (const cfg of clientsConfigs) {
      const tenantId = cfg.tenant_id;
      const metricClient = batchRun.metricas_por_cliente[tenantId];
      const clientStartTime = Date.now();

      for (let i = 0; i < cfg.quantidade; i++) {
        try {
          const docXml = MockGeneratorService.generateMockXML({ tenantId, tipoDoc: 'CTE' });
          const res = AverbacaoService.process({
            tenant_id: tenantId,
            ramo,
            xml_content: docXml
          });

          metricClient.total++;
          if (res.status === 'sucesso' || res.status === 'aviso') {
            metricClient.sucessos++;
            globalSucessos++;
          } else {
            metricClient.erros++;
            globalErros++;
          }
        } catch (e) {
          metricClient.total++;
          metricClient.erros++;
          globalErros++;
        }
      }

      const clientElapsedMs = Date.now() - clientStartTime;
      metricClient.tempo_medio_ms =
        metricClient.total > 0 ? Number((clientElapsedMs / metricClient.total).toFixed(2)) : 0;
    }

    const totalElapsedMs = Date.now() - startTime;
    const throughputSec =
      totalElapsedMs > 0 ? Number(((totalCalculado / totalElapsedMs) * 1000).toFixed(2)) : totalCalculado;

    batchRun.status = 'CONCLUIDO';
    batchRun.metricas_globais = {
      total: totalCalculado,
      sucessos: globalSucessos,
      erros: globalErros,
      tempo_total_ms: totalElapsedMs,
      throughput_docs_sec: throughputSec
    };

    dbStore.persist();

    return batchRun;
  }
}
