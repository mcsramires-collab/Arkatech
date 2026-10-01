import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import app from '../server';
import { dbStore } from '../services/dbStore';
import { auditService } from '../services/auditService';

describe('Portal audit annotation contracts', () => {
  const jwtSecret = crypto.randomBytes(32).toString('hex');

  beforeAll(() => {
    process.env.JWT_SECRET = jwtSecret;
  });

  test('deriva ator e insurer do Bearer e rejeita tenant fora da carteira', async () => {
    await dbStore.runTestLabEphemeral(async () => {
      auditService.clearForTests();
      const now = new Date().toISOString();
      dbStore.tenants = [
        { id: 'tenant-a', cnpj: '12345678000190', razao_social: 'A', status: 'ATIVO', ambiente: 'teste', client_id: 'a', client_secret_hash: 'a', role: 'TRANSPORTADOR', token_duration_hours: 8, created_at: now },
        { id: 'tenant-b', cnpj: '98765432000110', razao_social: 'B', status: 'ATIVO', ambiente: 'teste', client_id: 'b', client_secret_hash: 'b', role: 'TRANSPORTADOR', token_duration_hours: 8, created_at: now }
      ] as any;
      dbStore.policies = [
        { id: 'policy-a', numero_apolice: 'A', ramo: 'RCTRC', tenant_id: 'tenant-a', insurer_id: 'insurer-a', broker_id: 'broker-a', status: 'ATIVA', permitir_inativo_vencido: false, vigencia_inicio: now, vigencia_fim: '2027-12-31T23:59:59.000Z', aceita_averbacao_como_destinatario: false },
        { id: 'policy-b', numero_apolice: 'B', ramo: 'RCTRC', tenant_id: 'tenant-b', insurer_id: 'insurer-b', broker_id: 'broker-b', status: 'ATIVA', permitir_inativo_vencido: false, vigencia_inicio: now, vigencia_fim: '2027-12-31T23:59:59.000Z', aceita_averbacao_como_destinatario: false }
      ] as any;

      const token = jwt.sign({
        actor_type: 'SEGURADORA',
        user_id: 'user-a',
        nome: 'Ana Seguradora',
        email: 'ana@example.com',
        role: 'SEGURADORA',
        insurer_id: 'insurer-a'
      }, jwtSecret, { expiresIn: 3600, jwtid: 'audit-test-jti' });

      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

      try {
        const ok = await fetch(base + '/api/v1/admin/audit-events/portal', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            module: 'Regras de Negócio',
            entity_id: 'regra-1',
            tenant_id: 'tenant-a',
            insurer_id: 'insurer-b',
            actor_name: 'Usuário Falso',
            action: 'UPDATE',
            before: 'off',
            after: 'on'
          })
        });
        expect(ok.status).toBe(201);
        const body = await ok.json() as any;
        expect(body.audit_event).toMatchObject({
          actor_id: 'user-a',
          actor_name: 'Ana Seguradora',
          insurer_id: 'insurer-a',
          tenant_id: 'tenant-a'
        });

        const denied = await fetch(base + '/api/v1/admin/audit-events/portal', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            module: 'clientes',
            entity_id: 'tenant-b',
            tenant_id: 'tenant-b',
            action: 'UPDATE'
          })
        });
        expect(denied.status).toBe(403);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  });
});
