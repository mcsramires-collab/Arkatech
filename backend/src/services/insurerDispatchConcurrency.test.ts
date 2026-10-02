import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbStore } from './dbStore';
import { InsurerDispatchService } from './insurerDispatchService';
import type { Averbacao, Policy, Tenant } from '../types';

function makeFixture(suffix: string) {
  const tenant: Tenant = {
    id: `tenant_${suffix}`,
    cnpj: `12.345.678/0001-${suffix === 'a' ? '90' : '91'}`,
    razao_social: `Cliente ${suffix}`,
    status: 'ATIVO',
    ambiente: 'producao',
    client_id: `client_${suffix}`,
    client_secret_hash: 'hash',
    role: 'TRANSPORTADOR',
    token_duration_hours: 8,
    conta_ativada: true,
    created_at: new Date().toISOString()
  };
  const policy: Policy = {
    id: `policy_${suffix}`,
    numero_apolice: `POL-${suffix}`,
    ramo: 'RCTRC',
    tenant_id: tenant.id,
    insurer_id: 'ins_dispatch_test',
    broker_id: 'broker_dispatch_test',
    status: 'ATIVA',
    permitir_inativo_vencido: false,
    vigencia_inicio: '2026-01-01',
    vigencia_fim: '2026-12-31',
    aceita_averbacao_como_destinatario: false
  };
  const averbacao: Averbacao = {
    id: `avb_${suffix}`,
    protocolo_interno_averbacao: `PI-${suffix}`,
    tenant_id: tenant.id,
    policy_id: policy.id,
    status: 'SUCESSO',
    codigo_resposta: 'SUC-2000',
    mensagem_resposta: 'Aceite interno',
    valor_carga: 1000,
    valor_considerado_averbacao: 1000,
    regras_internas_aplicadas: [],
    tipo_documento: 'CTE',
    chave_documento: `3526101234567800019057001000000001100000001${suffix === 'a' ? '0' : '1'}`,
    raw_xml_id: `raw_${suffix}`,
    ambiente: 'producao',
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  return { tenant, policy, averbacao };
}

describe('InsurerDispatchService concorrência', () => {
  const originalFetch = global.fetch;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arckatech-dispatch-race-'));
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

  it('não perde um novo enqueue enquanto outro despacho aguarda resposta HTTP', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      const first = makeFixture('a');
      const second = makeFixture('b');
      dbStore.tenants = [first.tenant];
      dbStore.policies = [first.policy];
      dbStore.averbacoes = [first.averbacao];
      dbStore.rawXmlStore = [
        {
          id: first.averbacao.raw_xml_id,
          tenant_id: first.tenant.id,
          content_xml: '<CTe>primeiro</CTe>',
          hash_sha256: 'hash-a',
          encrypted_aes256: false,
          created_at: new Date().toISOString()
        }
      ];
      dbStore.fiscalDocuments = [];

      InsurerDispatchService.enqueue(first);

      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      global.fetch = jest.fn(async () => {
        await waiting;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: 'sucesso', numero_averbacao: 'SEG-A' })
        } as any;
      }) as typeof fetch;

      const processing = InsurerDispatchService.processDue(10);
      // processDue já chegou ao await do fetch; um novo request pode enfileirar neste intervalo.
      InsurerDispatchService.enqueue(second);
      release();
      const result = await processing;

      expect(result.confirmed).toBe(1);
      const all = InsurerDispatchService.list();
      expect(all).toHaveLength(2);
      expect(all.find((item) => item.averbacao_id === first.averbacao.id)?.status).toBe('CONFIRMED');
      expect(all.find((item) => item.averbacao_id === second.averbacao.id)?.status).toBe('PENDING');
    });
  });
});
