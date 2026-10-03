import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbStore } from './dbStore';
import { InsurerDispatchService } from './insurerDispatchService';
import type { Averbacao, Policy, Tenant } from '../types';

function fixture() {
  const tenant: Tenant = {
    id: 'tenant_dispatch_test',
    cnpj: '12.345.678/0001-90',
    razao_social: 'Cliente Dispatch Teste',
    status: 'ATIVO',
    ambiente: 'producao',
    client_id: 'client_dispatch',
    client_secret_hash: 'hash',
    role: 'TRANSPORTADOR',
    token_duration_hours: 8,
    conta_ativada: true,
    created_at: new Date().toISOString()
  };
  const policy: Policy = {
    id: 'policy_dispatch_test',
    numero_apolice: 'POL-DISPATCH-001',
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
    id: 'avb_dispatch_test',
    protocolo_interno_averbacao: 'PI-DISPATCH-001',
    tenant_id: tenant.id,
    policy_id: policy.id,
    status: 'SUCESSO',
    codigo_resposta: 'SUC-2000',
    mensagem_resposta: 'Aceite interno de teste',
    valor_carga: 1000,
    valor_considerado_averbacao: 1000,
    regras_internas_aplicadas: [],
    tipo_documento: 'CTE',
    chave_documento: '35261012345678000190570010000000011000000010',
    raw_xml_id: 'raw_dispatch_test',
    ambiente: 'producao',
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString()
  };
  return { tenant, policy, averbacao };
}

describe('InsurerDispatchService', () => {
  let dataDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arckatech-dispatch-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.INSURER_ADAPTER_URL;
    delete process.env.INSURER_ADAPTER_TOKEN;
    delete process.env.INSURER_ADAPTER_URL_INS_DISPATCH_TEST;
    delete process.env.INSURER_ADAPTER_TOKEN_INS_DISPATCH_TEST;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.DATA_DIR;
    delete process.env.INSURER_ADAPTER_URL;
    delete process.env.INSURER_ADAPTER_TOKEN;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('bloqueia a outbox quando endpoint/token da seguradora não estão configurados e nunca persiste segredo', () => {
    const { tenant, policy, averbacao } = fixture();
    const dispatch = InsurerDispatchService.enqueue({ tenant, policy, averbacao });

    expect(dispatch.status).toBe('BLOCKED_CONFIG');
    expect(dispatch.attempt_count).toBe(0);
    const persisted = fs.readFileSync(path.join(dataDir, 'insurer_dispatch_outbox.json'), 'utf-8');
    expect(persisted).toContain('BLOCKED_CONFIG');
    expect(persisted).not.toContain('authorization');
    expect(persisted).not.toContain('Bearer');
  });

  it('envia payload com idempotência e só marca SUCESSO após confirmação do adapter', async () => {
    process.env.INSURER_ADAPTER_URL = 'https://adapter.invalid/averbar';
    process.env.INSURER_ADAPTER_TOKEN = 'secret-only-in-env';

    await dbStore.runTestLabEphemeral(async () => {
      const { tenant, policy, averbacao } = fixture();
      (averbacao as any).status = 'PENDENTE_ENVIO';
      dbStore.tenants = [tenant];
      dbStore.policies = [policy];
      dbStore.averbacoes = [averbacao];
      dbStore.rawXmlStore = [
        {
          id: averbacao.raw_xml_id,
          tenant_id: tenant.id,
          content_xml: '<CTe>fixture</CTe>',
          hash_sha256: 'hash-dispatch',
          encrypted_aes256: false,
          created_at: new Date().toISOString()
        }
      ];
      dbStore.fiscalDocuments = [];

      let requestInit: RequestInit | undefined;
      global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestInit = init;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              status: 'sucesso',
              numero_averbacao: 'SEG-998877',
              protocolo: 'PROTO-EXT-123'
            })
        } as any;
      }) as typeof fetch;

      const queued = InsurerDispatchService.enqueue({ tenant, policy, averbacao });
      expect(queued.status).toBe('PENDING');

      const result = await InsurerDispatchService.processDue(10);
      expect(result.confirmed).toBe(1);
      expect(averbacao.status).toBe('SUCESSO');
      expect(averbacao.numero_averbacao).toBe('SEG-998877');
      expect((averbacao as any).protocolo_seguradora).toBe('PROTO-EXT-123');

      const headers = requestInit?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer secret-only-in-env');
      expect(headers['idempotency-key']).toBe(queued.idempotency_key);

      const payload = JSON.parse(String(requestInit?.body));
      expect(payload.dispatch_id).toBe(queued.id);
      expect(payload.policy.numero_apolice).toBe(policy.numero_apolice);
      expect(payload.raw_xml).toBe('<CTe>fixture</CTe>');

      const outboxText = fs.readFileSync(path.join(dataDir, 'insurer_dispatch_outbox.json'), 'utf-8');
      expect(outboxText).not.toContain('secret-only-in-env');
    });
  });

  it('mantém pendente e agenda retry para falha temporária HTTP', async () => {
    process.env.INSURER_ADAPTER_URL = 'https://adapter.invalid/averbar';
    process.env.INSURER_ADAPTER_TOKEN = 'secret-only-in-env';

    await dbStore.runTestLabEphemeral(async () => {
      const { tenant, policy, averbacao } = fixture();
      (averbacao as any).status = 'PENDENTE_ENVIO';
      dbStore.tenants = [tenant];
      dbStore.policies = [policy];
      dbStore.averbacoes = [averbacao];
      dbStore.rawXmlStore = [
        {
          id: averbacao.raw_xml_id,
          tenant_id: tenant.id,
          content_xml: '<CTe>fixture</CTe>',
          hash_sha256: 'hash-dispatch',
          encrypted_aes256: false,
          created_at: new Date().toISOString()
        }
      ];
      dbStore.fiscalDocuments = [];

      global.fetch = jest.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ mensagem: 'Indisponível temporariamente' })
      } as any)) as typeof fetch;

      InsurerDispatchService.enqueue({ tenant, policy, averbacao });
      const result = await InsurerDispatchService.processDue(10);
      expect(result.retried).toBe(1);
      expect((averbacao as any).status).toBe('PENDENTE_ENVIO');
      expect(InsurerDispatchService.list('RETRY')).toHaveLength(1);
      expect(InsurerDispatchService.list('RETRY')[0]?.next_attempt_at).toBeTruthy();
    });
  });
  it.each(['{}', '', '<html>proxy</html>', '{"status":"sucesso"}'])('não confirma HTTP 200 sem evidência externa: %s', async (body) => {
    process.env.INSURER_ADAPTER_URL = 'https://adapter.invalid/averbar';
    process.env.INSURER_ADAPTER_TOKEN = 'secret';
    await dbStore.runTestLabEphemeral(async () => {
      const {tenant,policy,averbacao} = fixture();
      (averbacao as any).status = 'PENDENTE_ENVIO';
      dbStore.tenants = [tenant]; dbStore.policies = [policy]; dbStore.averbacoes = [averbacao];
      dbStore.rawXmlStore = [{id:averbacao.raw_xml_id,tenant_id:tenant.id,content_xml:'<CTe/>',hash_sha256:'hash',encrypted_aes256:false,created_at:new Date().toISOString()}];
      dbStore.fiscalDocuments = [];
      global.fetch = jest.fn(async () => ({ok:true,status:200,text:async()=>body} as any)) as typeof fetch;
      InsurerDispatchService.enqueue({tenant,policy,averbacao});
      const result = await InsurerDispatchService.processDue();
      expect(result.confirmed).toBe(0);
      expect(result.retried).toBe(1);
      expect((averbacao as any).status).toBe('PENDENTE_ENVIO');
    });
  });

});
