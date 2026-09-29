import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import app from '../server';
import { dbStore } from '../services/dbStore';
import { ConnectorService } from '../services/connectorService';
import { MockGeneratorService } from '../services/mockGenerator';

describe('Test Lab HTTP/API contracts', () => {
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const internalKey = crypto.randomBytes(32).toString('hex');
  const whatsappKey = crypto.randomBytes(32).toString('hex');

  beforeAll(() => {
    process.env.JWT_SECRET = jwtSecret;
    process.env.INTERNAL_API_KEY = internalKey;
    process.env.WHATSAPP_INTEGRATION_KEY = whatsappKey;
  });

  test('prova TMS, Connector OUTBOUND, WhatsApp e APIs do Laboratório pela camada HTTP real', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      const now = new Date().toISOString();
      const tenantId = 'api-lab-tenant';
      const policyId = 'api-lab-policy';

      dbStore.tenants = [
        {
          id: tenantId,
          cnpj: '12345678000190',
          razao_social: 'TENANT API LAB',
          status: 'ATIVO',
          ambiente: 'teste',
          client_id: 'api-lab-client',
          client_secret_hash: 'not-used-in-this-test',
          role: 'TRANSPORTADOR',
          token_duration_hours: 8,
          conta_ativada: true,
          created_at: now
        }
      ] as any;

      dbStore.insurers = [
        {
          id: 'api-lab-insurer',
          cnpj: '11111111000191',
          nome: 'SEGURADORA API LAB',
          created_at: now
        }
      ] as any;

      dbStore.brokers = [
        {
          id: 'api-lab-broker',
          cnpj: '22222222000192',
          nome: 'CORRETORA API LAB',
          created_at: now
        }
      ] as any;

      dbStore.policies = [
        {
          id: policyId,
          numero_apolice: 'API-LAB-001',
          ramo: 'RCTRC',
          tenant_id: tenantId,
          insurer_id: 'api-lab-insurer',
          broker_id: 'api-lab-broker',
          status: 'ATIVA',
          permitir_inativo_vencido: false,
          vigencia_inicio: '2026-01-01T00:00:00.000Z',
          vigencia_fim: '2027-12-31T23:59:59.000Z',
          aceita_averbacao_como_destinatario: false
        }
      ] as any;

      dbStore.policyBusinessSettings = [];
      dbStore.fiscalDocuments = [];
      dbStore.averbacoes = [];
      dbStore.rawXmlStore = [];
      dbStore.connectors = [];
      dbStore.whatsappMessages = [];

      const tenantToken = jwt.sign(
        {
          tenant_id: tenantId,
          cnpj: '12345678000190',
          razao_social: 'TENANT API LAB',
          ambiente: 'teste',
          role: 'TRANSPORTADOR'
        },
        jwtSecret,
        { expiresIn: 3600 }
      );

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const base = 'http://127.0.0.1:' + port;

      try {
        const unauthenticated = await fetch(base + '/api/v1/admin/test-lab/catalog');
        expect(unauthenticated.status).toBe(401);
        const insurerToken = jwt.sign({ actor_type: 'INSURER_USER', user_id: 'foreign-insurer', insurer_id: 'foreign-insurer', role: 'ADM' }, jwtSecret, { expiresIn: 3600 });
        for (const endpoint of ['catalog', 'runs']) {
          const denied = await fetch(base + '/api/v1/admin/test-lab/' + endpoint, { headers: { authorization: 'Bearer ' + insurerToken } });
          expect(denied.status).toBe(403);
        }
        const environment = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
          const blocked = await fetch(base + '/api/v1/admin/test-lab/execute', {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-api-key': internalKey }, body: '{}'
          });
          expect(blocked.status).toBe(409);
          const blockedBody = await blocked.json() as any;
          expect(blockedBody.codigo).toBe('TEST_LAB_PRODUCTION_BLOCKED');
          expect(blockedBody.mensagem).toContain('TEST_LAB_ENABLED=true');
        } finally { process.env.NODE_ENV = environment; }
        const planResponse = await fetch(base + '/api/v1/admin/test-lab/plan', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-api-key': internalKey
          },
          body: JSON.stringify({ mode: 'QUICK', suite_keys: ['p0-access-isolation'] })
        });
        expect(planResponse.status).toBe(200);
        const planBody = await planResponse.json() as any;
        expect(planBody.status).toBe('sucesso');
        expect(planBody.plan.total_scenarios).toBeGreaterThan(0);

        const tmsXml = MockGeneratorService.generateMockXML({
          tenantId,
          policyId,
          tipoDoc: 'CTE',
          documentNumber: 580001,
          valorCarga: 900,
          tpAmbSefaz: 2,
          incluirProtocoloSefaz: true,
          cStatSefaz: '100'
        });

        const tmsResponse = await fetch(base + '/api/v1/tms/documents', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + tenantToken,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            source_system: 'TEST_LAB_TMS',
            documents: [{ external_id: 'TMS-580001', xml_content: tmsXml }]
          })
        });
        expect(tmsResponse.status).toBe(200);
        const tmsBody = await tmsResponse.json() as any;
        expect(tmsBody.status).toBe('sucesso');
        expect(tmsBody.results[0].status).toBe('AVERBADO');

        const registration = ConnectorService.register({
          tenant_id: tenantId,
          device_id: 'api-lab-device',
          device_name: 'API LAB DEVICE',
          version: '1.0.0',
          os: 'windows',
          capabilities: ['CTE_DFE']
        });

        const unauthorizedXml = MockGeneratorService.generateMockXML({
          tenantId,
          policyId,
          tipoDoc: 'CTE',
          documentNumber: 580002,
          valorCarga: 901,
          tpAmbSefaz: 2,
          incluirProtocoloSefaz: false,
          cStatSefaz: '204'
        });

        const connectorResponse = await fetch(base + '/api/v1/connector/fiscal-documents', {
          method: 'POST',
          headers: {
            'x-connector-token': registration.device_token,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            provider: 'CTE',
            capture_mode: 'OUTBOUND',
            documents: [{ external_id: 'OUTBOUND-580002', xml: unauthorizedXml }]
          })
        });
        expect(connectorResponse.status).toBe(200);
        const connectorBody = await connectorResponse.json() as any;
        expect(connectorBody.results[0].status).toBe('IGNORADO');

        const whatsappXml = MockGeneratorService.generateMockXML({
          tenantId,
          policyId,
          tipoDoc: 'CTE',
          documentNumber: 580003,
          valorCarga: 902,
          tpAmbSefaz: 2,
          incluirProtocoloSefaz: true,
          cStatSefaz: '100'
        });

        const whatsappResponse = await fetch(base + '/api/v1/integrations/whatsapp/inbound', {
          method: 'POST',
          headers: {
            'x-whatsapp-integration-key': whatsappKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            provider: 'TEST_META',
            provider_message_id: 'WA-580003',
            from: '5511999999999',
            tenant_id: tenantId,
            kind: 'DOCUMENT',
            document_name: 'cte-580003.xml',
            document_mime_type: 'application/xml',
            content_base64: Buffer.from(whatsappXml, 'utf8').toString('base64')
          })
        });
        expect(whatsappResponse.status).toBe(200);
        const whatsappBody = await whatsappResponse.json() as any;
        expect(whatsappBody.action).toBe('FISCAL_DOCUMENT_INGESTION');
        expect(whatsappBody.results[0].status).toBe('AVERBADO');
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    });
  });
});
