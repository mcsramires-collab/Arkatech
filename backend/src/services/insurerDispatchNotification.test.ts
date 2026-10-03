import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbStore } from './dbStore';
import { InsurerDispatchService } from './insurerDispatchService';
import type { Averbacao, Policy, Tenant } from '../types';

describe('InsurerDispatchService notificação final', () => {
  const originalFetch = global.fetch;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arckatech-dispatch-notify-'));
    process.env.DATA_DIR = dataDir;
    process.env.INSURER_ADAPTER_URL = 'https://adapter.invalid/averbar';
    process.env.INSURER_ADAPTER_TOKEN = 'secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.DATA_DIR;
    delete process.env.INSURER_ADAPTER_URL;
    delete process.env.INSURER_ADAPTER_TOKEN;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('gera alerta de recusa quando o adapter rejeita definitivamente', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      const tenant: Tenant = {
        id: 'tenant_notify',
        cnpj: '12.345.678/0001-90',
        razao_social: 'Cliente Notify',
        status: 'ATIVO',
        ambiente: 'producao',
        client_id: 'client_notify',
        client_secret_hash: 'hash',
        role: 'TRANSPORTADOR',
        token_duration_hours: 8,
        conta_ativada: true,
        created_at: new Date().toISOString()
      };
      const policy: Policy = {
        id: 'policy_notify',
        numero_apolice: 'POL-NOTIFY',
        ramo: 'RCTRC',
        tenant_id: tenant.id,
        insurer_id: 'ins_notify',
        broker_id: 'broker_notify',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01',
        vigencia_fim: '2026-12-31',
        aceita_averbacao_como_destinatario: false
      };
      const averbacao: Averbacao = {
        id: 'avb_notify',
        protocolo_interno_averbacao: 'PI-NOTIFY',
        tenant_id: tenant.id,
        policy_id: policy.id,
        status: 'SUCESSO',
        codigo_resposta: 'SUC-2000',
        mensagem_resposta: 'Aceite interno',
        valor_carga: 1000,
        valor_considerado_averbacao: 1000,
        regras_internas_aplicadas: [],
        tipo_documento: 'CTE',
        chave_documento: '35261012345678000190570010000000011000000010',
        raw_xml_id: 'raw_notify',
        ambiente: 'producao',
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString()
      };

      dbStore.tenants = [tenant];
      dbStore.policies = [policy];
      dbStore.averbacoes = [averbacao];
      dbStore.rawXmlStore = [{
        id: averbacao.raw_xml_id,
        tenant_id: tenant.id,
        content_xml: '<CTe>notify</CTe>',
        hash_sha256: 'hash-notify',
        encrypted_aes256: false,
        created_at: new Date().toISOString()
      }];
      dbStore.fiscalDocuments = [];
      dbStore.operationalNotifications = [];

      global.fetch = jest.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({
          status: 'recusado',
          codigo: 'SEG-422',
          mensagem: 'Documento recusado pela seguradora.',
          retryable: false
        })
      } as any)) as typeof fetch;

      const dispatch = InsurerDispatchService.enqueue({ tenant, policy, averbacao });
      const result = await InsurerDispatchService.processDue(10);

      expect(result.failed).toBe(1);
      expect(averbacao.status).toBe('ERRO');
      expect(dbStore.operationalNotifications).toHaveLength(1);
      expect(dbStore.operationalNotifications[0]?.type).toBe('AVERBACAO_RECUSADA');
      expect(dbStore.operationalNotifications[0]?.message).toBe('Documento recusado pela seguradora.');
      expect(dbStore.operationalNotifications[0]?.context).toMatchObject({
        insurer_dispatch_id: dispatch.id,
        averbacao_id: averbacao.id,
        insurer_id: policy.insurer_id,
        codigo: 'SEG-422',
        http_status: 422
      });
    });
  });
});
