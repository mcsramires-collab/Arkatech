import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import app from '../server';
import { dbStore } from '../services/dbStore';

describe('Backend integrity HTTP contracts', () => {
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const internalKey = crypto.randomBytes(32).toString('hex');

  beforeAll(() => {
    process.env.JWT_SECRET = jwtSecret;
    process.env.INTERNAL_API_KEY = internalKey;
  });

  test('sincroniza 54/55 em uma única operação e mantém isolamento por seguradora', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      const timestamp = new Date().toISOString();
      const tenantId = 'integrity-tenant';
      const insurerA = 'integrity-insurer-a';
      const insurerB = 'integrity-insurer-b';
      const brokerId = 'integrity-broker';
      const policy54 = 'integrity-policy-54';
      const policy55 = 'integrity-policy-55';
      const policy59OtherInsurer = 'integrity-policy-59-b';

      dbStore.tenants = [
        {
          id: tenantId,
          cnpj: '12345678000190',
          razao_social: 'TENANT INTEGRITY',
          status: 'ATIVO',
          ambiente: 'teste',
          client_id: 'integrity-client',
          client_secret_hash: 'unused',
          role: 'TRANSPORTADOR',
          token_duration_hours: 8,
          conta_ativada: true,
          created_at: timestamp
        }
      ] as any;
      dbStore.insurers = [
        { id: insurerA, cnpj: '11111111000191', nome: 'SEG A', created_at: timestamp },
        { id: insurerB, cnpj: '22222222000192', nome: 'SEG B', created_at: timestamp }
      ] as any;
      dbStore.brokers = [
        { id: brokerId, cnpj: '33333333000193', nome: 'BROKER', created_at: timestamp }
      ] as any;
      dbStore.policies = [
        {
          id: policy54,
          numero_apolice: 'POL-54',
          ramo: 'RCTRC',
          tenant_id: tenantId,
          insurer_id: insurerA,
          broker_id: brokerId,
          status: 'ATIVA',
          permitir_inativo_vencido: false,
          aceita_averbacao_como_destinatario: false,
          vigencia_inicio: '2026-01-01T00:00:00.000Z',
          vigencia_fim: '2027-12-31T23:59:59.999Z'
        },
        {
          id: policy55,
          numero_apolice: 'POL-55',
          ramo: 'RCDC',
          tenant_id: tenantId,
          insurer_id: insurerA,
          broker_id: brokerId,
          status: 'ATIVA',
          permitir_inativo_vencido: false,
          aceita_averbacao_como_destinatario: false,
          vigencia_inicio: '2026-01-01T00:00:00.000Z',
          vigencia_fim: '2027-12-31T23:59:59.999Z'
        },
        {
          id: policy59OtherInsurer,
          numero_apolice: 'POL-59-B',
          ramo: 'RCV',
          tenant_id: tenantId,
          insurer_id: insurerB,
          broker_id: brokerId,
          status: 'ATIVA',
          permitir_inativo_vencido: false,
          aceita_averbacao_como_destinatario: false,
          vigencia_inicio: '2026-01-01T00:00:00.000Z',
          vigencia_fim: '2027-12-31T23:59:59.999Z'
        }
      ] as any;

      dbStore.policyBusinessSettings = [
        { id: 'settings-54', policy_id: policy54, config: { 'regras:placa': true }, updated_at: timestamp },
        { id: 'settings-55-old', policy_id: policy55, config: { 'regras:placa': false }, updated_at: timestamp }
      ] as any;
      dbStore.policySublimites = [
        { id: 'sublimit-54', policy_id: policy54, tag: 'Eletronicos', valor: '100000', created_at: timestamp },
        { id: 'sublimit-55-old', policy_id: policy55, tag: 'Antigo', valor: '1', created_at: timestamp }
      ] as any;
      dbStore.policyTitularityRules = [
        { id: 'titularity-54', policy_id: policy54, funcao: 'DESTINATARIO', habilitada: true }
      ] as any;
      dbStore.policyBypassRules = [
        { id: 'bypass-54', policy_id: policy54, rota_uf_origem: 'SP', rota_uf_destino: 'RJ' }
      ] as any;
      dbStore.insurerCoverages = [
        {
          id: 'coverage-a',
          insurer_id: insurerA,
          titulo: 'Container',
          obrigatoria: false,
          aplicar_todos_clientes: true,
          tipo_valor: 'monetario',
          created_at: timestamp
        }
      ] as any;
      dbStore.policyCoverageValues = [
        {
          id: 'coverage-value-54',
          policy_id: policy54,
          insurer_coverage_id: 'coverage-a',
          valor: 25000,
          desconta_lmi: true,
          created_at: timestamp,
          updated_at: timestamp
        }
      ] as any;
      dbStore.businessRuleRequests = [];

      dbStore.tenantUsers = [{
        id: 'tenant-user-1', tenant_id: tenantId, nome: 'Usuario Tenant', email: 'integrity@example.com',
        password_hash: 'unused', status: 'ATIVO', created_at: timestamp
      }];
      const tenantToken = jwt.sign(
        {
          tenant_id: tenantId,
          cnpj: '12345678000190',
          razao_social: 'TENANT INTEGRITY',
          ambiente: 'teste',
          role: 'TRANSPORTADOR',
          tenant_user_id: 'tenant-user-1',
          tenant_user_nome: 'Usuario Tenant'
        },
        jwtSecret,
        { expiresIn: 3600 }
      );

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      try {
        const syncResponse = await fetch(base + '/api/v1/admin/policy-config-sync', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-api-key': internalKey
          },
          body: JSON.stringify({
            source_policy_id: policy54,
            target_policy_id: policy55
          })
        });
        expect(syncResponse.status).toBe(200);
        const syncBody = await syncResponse.json() as any;
        expect(syncBody.status).toBe('sucesso');
        expect(syncBody.copied).toEqual(
          expect.objectContaining({
            business_settings: 1,
            coverage_values: 1,
            sublimits: 1,
            titularity: 1,
            bypass: 1
          })
        );
        expect(dbStore.policyBusinessSettings.find((item) => item.policy_id === policy55)?.config).toEqual({ 'regras:placa': true });
        expect(dbStore.policySublimites.filter((item) => item.policy_id === policy55)).toHaveLength(1);
        expect(dbStore.policySublimites.find((item) => item.policy_id === policy55)?.tag).toBe('Eletronicos');
        expect(dbStore.policyCoverageValues.find((item) => item.policy_id === policy55)?.desconta_lmi).toBe(true);

        const ambiguousRequest = await fetch(base + '/api/v1/tenant/regras-solicitacoes', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + tenantToken, 'content-type': 'application/json' },
          body: JSON.stringify({ tipo: 'Alterar limite', descricao: 'Teste multi-seguradora' })
        });
        expect(ambiguousRequest.status).toBe(409);
        const ambiguousBody = await ambiguousRequest.json() as any;
        expect(ambiguousBody.codigo).toBe('POLICY_REQUIRED_FOR_RULE_REQUEST');

        const scopedRequest = await fetch(base + '/api/v1/tenant/regras-solicitacoes', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + tenantToken, 'content-type': 'application/json' },
          body: JSON.stringify({
            policy_id: policy54,
            tipo: 'Alterar limite',
            descricao: 'Solicitacao direcionada'
          })
        });
        expect(scopedRequest.status).toBe(200);
        const scopedBody = await scopedRequest.json() as any;
        expect(scopedBody.solicitacao.policy_id).toBe(policy54);
        expect(scopedBody.solicitacao.insurer_id).toBe(insurerA);
        expect(scopedBody.solicitacao.ramo).toBe('RCTRC');
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    });
  });
});
