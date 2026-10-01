import crypto from 'crypto';
import type { AddressInfo } from 'net';
import app from '../server';
import { dbStore } from '../services/dbStore';
import { auditService } from '../services/auditService';

describe('Admin consistency HTTP contracts', () => {
  const internalKey = crypto.randomBytes(32).toString('hex');

  beforeAll(() => {
    process.env.INTERNAL_API_KEY = internalKey;
  });

  test('CNPJ lifecycle, reversão sem apagar histórico e save atômico da ficha', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      auditService.clearForTests();
      const now = new Date().toISOString();
      dbStore.tenants = [{
        id: 'tenant-consistency', cnpj: '12345678000190', razao_social: 'Cliente Original',
        status: 'ATIVO', ambiente: 'teste', client_id: 'x', client_secret_hash: 'x', role: 'TRANSPORTADOR',
        token_duration_hours: 8, created_at: now
      }] as any;
      dbStore.insurers = [{ id: 'insurer-consistency', cnpj: '11111111000191', nome: 'Seg A', created_at: now }] as any;
      dbStore.brokers = [
        { id: 'broker-old', cnpj: '22222222000192', nome: 'Broker Old', created_at: now },
        { id: 'broker-new', cnpj: '33333333000193', nome: 'Broker New', created_at: now }
      ] as any;
      dbStore.policies = [{
        id: 'policy-consistency', numero_apolice: 'POL-1', ramo: 'RCTRC', tenant_id: 'tenant-consistency',
        insurer_id: 'insurer-consistency', broker_id: 'broker-new', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z', vigencia_fim: '2027-01-01T00:00:00.000Z',
        aceita_averbacao_como_destinatario: false
      }] as any;
      dbStore.policyPartnerHistory = [
        { id: 'hist-old', policy_id: 'policy-consistency', papel: 'lider', broker_id: 'broker-old', vigencia_inicio: '2026-01-01T00:00:00.000Z', vigencia_fim: '2026-09-30T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'hist-new', policy_id: 'policy-consistency', papel: 'lider', broker_id: 'broker-new', vigencia_inicio: '2026-10-01T00:00:00.000Z', created_at: new Date().toISOString() }
      ] as any;
      dbStore.tenantCnpjsAdicionais = [];
      dbStore.policyBusinessSettings = [];
      dbStore.policyTitularityRules = [];
      dbStore.policyBypassRules = [];
      dbStore.policySublimites = [];
      dbStore.policyCoverageValues = [];
      dbStore.insurerCoverages = [];

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const headers = { 'content-type': 'application/json', 'x-internal-api-key': internalKey };

      try {
        const created = await fetch(base + '/api/v1/admin/tenants/tenant-consistency/cnpjs-adicionais', {
          method: 'POST', headers, body: JSON.stringify({ cnpj: '12345678000270', tipo: 'filial', razao_social: 'Filial 2', cidade: 'Indaiatuba', uf: 'SP' })
        });
        expect(created.status).toBe(201);
        const createdBody = await created.json() as any;
        expect(createdBody.cnpj_adicional.cidade).toBe('Indaiatuba');

        const scheduled = await fetch(base + '/api/v1/admin/tenants/tenant-consistency/cnpjs-adicionais/' + createdBody.cnpj_adicional.id, {
          method: 'PUT', headers, body: JSON.stringify({ status: 'INATIVO', inativacao_programada_para: '2099-01-01T00:00:00.000Z' })
        });
        const scheduledBody = await scheduled.json() as any;
        expect(scheduledBody.cnpj_adicional.status).toBe('ATIVO');
        expect(scheduledBody.cnpj_adicional.inativacao_programada_para).toBe('2099-01-01T00:00:00.000Z');

        const reversed = await fetch(base + '/api/v1/admin/policies/policy-consistency/trocar-parceria/hist-new/desfazer', {
          method: 'POST', headers, body: JSON.stringify({ motivo: 'Correção de cadastro' })
        });
        expect(reversed.status).toBe(200);
        expect(dbStore.policies[0].broker_id).toBe('broker-old');
        expect(dbStore.policyPartnerHistory.find((item: any) => item.id === 'hist-new')).toMatchObject({ revertido_em: expect.any(String) });
        expect(dbStore.policyPartnerHistory.length).toBe(3);

        const invalidSave = await fetch(base + '/api/v1/admin/insured-profile/tenant-consistency', {
          method: 'PUT', headers, body: JSON.stringify({
            company: { razao_social: 'Não deve persistir' },
            coverage_values: [{ policy_id: 'policy-consistency', items: [{ insurer_coverage_id: 'missing', valor: 10 }] }]
          })
        });
        expect(invalidSave.status).toBe(400);
        expect(dbStore.tenants[0].razao_social).toBe('Cliente Original');

        const validSave = await fetch(base + '/api/v1/admin/insured-profile/tenant-consistency', {
          method: 'PUT', headers, body: JSON.stringify({
            company: { razao_social: 'Cliente Atualizado', nome_fantasia: 'Atualizado' },
            policies: [{ id: 'policy-consistency', lmi: 250000 }],
            business_settings: [{ policy_id: 'policy-consistency', config: { 'regras:placa': true } }]
          })
        });
        expect(validSave.status).toBe(200);
        expect(dbStore.tenants[0].razao_social).toBe('Cliente Atualizado');
        expect(dbStore.policies[0].lmi).toBe(250000);
        expect(dbStore.policyBusinessSettings[0].config['regras:placa']).toBe(true);

        const audit = await fetch(base + '/api/v1/admin/audit-events?tenant_id=tenant-consistency', { headers: { 'x-internal-api-key': internalKey } });
        expect(audit.status).toBe(200);
        const auditBody = await audit.json() as any;
        expect(auditBody.audit_events.some((event: any) => event.action === 'REVERSAL')).toBe(true);
        expect(auditBody.audit_events.some((event: any) => event.action === 'BULK_UPDATE')).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  });
});
