import crypto from 'crypto';
import type { AddressInfo } from 'net';
import app from '../server';
import { dbStore } from '../services/dbStore';

describe('Internal ecosystem registry HTTP contracts', () => {
  const internalKey = crypto.randomBytes(32).toString('hex');

  beforeAll(() => {
    process.env.INTERNAL_API_KEY = internalKey;
  });

  test('cadastra e administra seguradora, corretora e assessoria sem duplicar co-corretora', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      dbStore.tenants = [];
      dbStore.insurers = [];
      dbStore.brokers = [];
      dbStore.policies = [];

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const headers = {
        'content-type': 'application/json',
        'x-internal-api-key': internalKey
      };

      try {
        const denied = await fetch(`${base}/api/v1/internal/ecosystem-partners`);
        expect(denied.status).toBe(401);

        const corretoraResponse = await fetch(`${base}/api/v1/internal/ecosystem-partners`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            entity_type: 'CORRETORA',
            cnpj: '11222333000181',
            razao_social: 'CORRETORA LAB ECOSSISTEMA',
            nome_fantasia: 'CORRETORA LAB'
          })
        });
        expect(corretoraResponse.status).toBe(201);
        const corretora = (await corretoraResponse.json()) as any;
        expect(corretora.partner.entity_type).toBe('CORRETORA');
        expect(corretora.partner.capabilities.pode_atuar_como_cocorretora).toBe(true);
        expect(dbStore.brokers[0]?.partner_type).toBe('CORRETORA');
        expect(dbStore.tenants.find((item) => item.id === dbStore.brokers[0]?.tenant_id)?.role).toBe('CORRETORA');

        const assessoriaResponse = await fetch(`${base}/api/v1/internal/ecosystem-partners`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            entity_type: 'ASSESSORIA',
            cnpj: '11444777000161',
            razao_social: 'ASSESSORIA LAB ECOSSISTEMA'
          })
        });
        expect(assessoriaResponse.status).toBe(201);
        const assessoria = (await assessoriaResponse.json()) as any;
        expect(assessoria.partner.entity_type).toBe('ASSESSORIA');
        expect(assessoria.partner.capabilities.pode_atuar_como_assessoria).toBe(true);
        expect(assessoria.partner.capabilities.pode_atuar_como_cocorretora).toBe(false);

        const insurerResponse = await fetch(`${base}/api/v1/internal/ecosystem-partners`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            entity_type: 'SEGURADORA',
            cnpj: '11111111000191',
            razao_social: 'SEGURADORA LAB ECOSSISTEMA'
          })
        });
        expect(insurerResponse.status).toBe(201);
        const insurer = (await insurerResponse.json()) as any;
        expect(insurer.partner.entity_type).toBe('SEGURADORA');
        expect(dbStore.insurers).toHaveLength(1);

        const duplicate = await fetch(`${base}/api/v1/internal/ecosystem-partners`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            entity_type: 'ASSESSORIA',
            cnpj: '11222333000181',
            razao_social: 'DUPLICADA'
          })
        });
        expect(duplicate.status).toBe(409);
        const duplicateBody = (await duplicate.json()) as any;
        expect(duplicateBody.codigo).toBe('ECOSYSTEM_CNPJ_ALREADY_REGISTERED');

        const corretoraId = corretora.partner.id;
        const update = await fetch(`${base}/api/v1/internal/ecosystem-partners/broker/${corretoraId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            entity_type: 'AMBOS',
            status: 'INATIVO'
          })
        });
        expect(update.status).toBe(200);
        const updateBody = (await update.json()) as any;
        expect(updateBody.partner.entity_type).toBe('AMBOS');
        expect(updateBody.partner.status).toBe('INATIVO');
        expect(updateBody.partner.capabilities.pode_atuar_como_cocorretora).toBe(true);
        expect(updateBody.partner.capabilities.pode_atuar_como_assessoria).toBe(true);

        const list = await fetch(`${base}/api/v1/internal/ecosystem-partners`, { headers });
        expect(list.status).toBe(200);
        const listBody = (await list.json()) as any;
        expect(listBody.partners).toHaveLength(3);
        expect(listBody.metadata.co_corretora_is_policy_role).toBe(true);
      } finally {
        server.close();
      }
    });
  });
});
