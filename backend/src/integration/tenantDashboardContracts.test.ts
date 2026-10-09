import crypto from 'crypto';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import app from '../server';
import { dbStore } from '../services/dbStore';

describe('Tenant dashboard real monthly HTTP contract', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const now = new Date('2026-10-15T12:00:00.000Z');
  let server: ReturnType<typeof app.listen>;
  let base: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout'] });
    jest.setSystemTime(now);
  });

  afterAll(async () => {
    jest.useRealTimers();
  });

  async function withFixture(run: () => Promise<void>) {
    await dbStore.runTestLabEphemeral(async () => {
      fixture();
      server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tenant/dashboard-stats`;
      try {
        await run();
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }

  const token = (tenant_id = 'dashboard-a') => jwt.sign({ tenant_id, ambiente: 'teste', role: 'TRANSPORTADOR' }, secret, { expiresIn: '1h' });
  const read = (query = '', tenant = 'dashboard-a') => fetch(base + query, { headers: { authorization: `Bearer ${token(tenant)}` } });

  function fixture() {
    dbStore.tenants = [
      { id: 'dashboard-a', conta_ativada: true, status: 'ATIVO' },
      { id: 'dashboard-b', conta_ativada: true, status: 'ATIVO' },
      { id: 'dashboard-inactive', conta_ativada: false, status: 'ATIVO' }
    ] as any;
    dbStore.policies = [
      { id: 'dashboard-policy-a', tenant_id: 'dashboard-a', ramo: 'RCTRC' },
      { id: 'dashboard-policy-b', tenant_id: 'dashboard-b', ramo: 'RCDC' }
    ] as any;
    dbStore.averbacoes = [];
    dbStore.recoverySessions = [];
    dbStore.businessRuleRequests = [];
  }

  function add(id: string, created_at: string, status = 'SUCESSO', tenant_id = 'dashboard-a', value = 100) {
    dbStore.averbacoes.push({
      id, tenant_id, policy_id: tenant_id === 'dashboard-a' ? 'dashboard-policy-a' : 'dashboard-policy-b',
      created_at, timestamp: created_at, status, valor_considerado_averbacao: value,
      numero_averbacao: status === 'SUCESSO' ? `AV-${id}` : undefined,
      tipo_documento: 'CTE', raw_xml_id: 'not-returned', recovery_token: 'not-returned'
    } as any);
  }

  test('counts selected business month, compares the previous month and isolates tenant', async () => {
    await withFixture(async () => {
      add('august', '2026-09-01T02:59:59Z');
      add('september-start', '2026-09-01T03:00:00Z');
      add('september-end', '2026-10-01T02:59:59Z');
      add('october', '2026-10-01T03:00:00Z');
      add('refused-september', '2026-09-20T12:00:00Z', 'ERRO');
      add('other-tenant', '2026-09-20T12:00:00Z', 'SUCESSO', 'dashboard-b', 9000);
      add('cancelled', '2026-09-20T12:00:00Z', 'CANCELADO');
      add('pending', '2026-09-20T12:00:00Z', 'PENDENTE_APROVACAO');
      const response = await read('?mes=2026-09&tenant_id=dashboard-b');
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.stats).toMatchObject({
        total_averbacoes: 2, total_recusadas: 1, valor_total_averbado: 200,
        periodo: { mes: '2026-09', mes_anterior: '2026-08', timezone: 'America/Sao_Paulo', escopo_pendencias: 'ATUAL' },
        comparacoes: { averbacoes: { value: 100, direction: 'up' } }
      });
      expect(body.stats.ultimas_averbacoes.map((a: any) => a.id)).toEqual(['september-end', 'september-start']);
      expect(JSON.stringify(body)).not.toContain('not-returned');
      expect(JSON.stringify(body)).not.toContain('other-tenant');
    });
  });

  test('sorts before limiting, excludes future and invalid timestamps, and never mutates storage order', async () => {
    await withFixture(async () => {
      for (let day = 1; day <= 7; day++) add(`day-${day}`, `2026-10-0${day}T12:00:00Z`);
      add('future', '2026-10-16T12:00:00Z');
      add('invalid', 'not-a-date');
      const originalOrder = dbStore.averbacoes.map((item) => item.id);
      const body = await (await read()).json() as any;
      expect(body.stats.total_averbacoes).toBe(7);
      expect(body.stats.periodo.mes).toBe('2026-10');
      expect(body.stats.ultimas_averbacoes.map((a: any) => a.id)).toEqual(['day-7', 'day-6', 'day-5', 'day-4', 'day-3']);
      expect(dbStore.averbacoes.map((item) => item.id)).toEqual(originalOrder);
    });
  });

  test('keeps recovery and rule queues current when viewing closed months', async () => {
    await withFixture(async () => {
      dbStore.recoverySessions = [
        { tenant_id: 'dashboard-a', utilizada: false, expira_em: '2026-10-16T12:00:00Z' },
        { tenant_id: 'dashboard-a', utilizada: false, expira_em: now.toISOString() },
        { tenant_id: 'dashboard-a', utilizada: true, expira_em: '2026-10-16T12:00:00Z' },
        { tenant_id: 'dashboard-b', utilizada: false, expira_em: '2026-10-16T12:00:00Z' }
      ] as any;
      dbStore.businessRuleRequests = [
        { tenant_id: 'dashboard-a', status: 'PENDENTE' },
        { tenant_id: 'dashboard-a', status: 'APROVADA' },
        { tenant_id: 'dashboard-b', status: 'PENDENTE' }
      ] as any;
      const body = await (await read('?mes=2026-08')).json() as any;
      expect(body.stats).toMatchObject({ total_averbacoes: 0, total_pendentes_recuperacao: 1, solicitacoes_regras_pendentes: 1 });
      expect(body.stats.ultimas_averbacoes).toEqual([]);
      expect(body.stats.comparacoes.averbacoes).toEqual({ value: 0, direction: 'up' });
    });
  });

  test('does not join a foreign policy into a tenant record', async () => {
    await withFixture(async () => {
      add('broken-reference', '2026-10-02T12:00:00Z');
      dbStore.averbacoes[0].policy_id = 'dashboard-policy-b';
      const body = await (await read()).json() as any;
      expect(body.stats.ultimas_averbacoes[0].ramo).toBeUndefined();
    });
  });

  test('handles January rollover and percentage decreases from persisted values', async () => {
    await withFixture(async () => {
      add('december-a', '2025-12-02T12:00:00Z', 'SUCESSO', 'dashboard-a', 300);
      add('december-b', '2025-12-03T12:00:00Z', 'SUCESSO', 'dashboard-a', 100);
      add('january', '2026-01-02T12:00:00Z', 'SUCESSO', 'dashboard-a', 100);
      const body = await (await read('?mes=2026-01')).json() as any;
      expect(body.stats.periodo.mes_anterior).toBe('2025-12');
      expect(body.stats.comparacoes.averbacoes).toEqual({ value: 50, direction: 'down' });
      expect(body.stats.comparacoes.valor_total_averbado).toEqual({ value: 75, direction: 'down' });
    });
  });

  test('defaults to the São Paulo month at UTC rollover with a human portal session', async () => {
    await withFixture(async () => {
      jest.setSystemTime(new Date('2026-10-01T01:00:00Z'));
      try {
        dbStore.tenantUsers = [{ id: 'dashboard-human', tenant_id: 'dashboard-a', status: 'ATIVO' }] as any;
        add('late-september', '2026-10-01T00:30:00Z');
        const humanToken = jwt.sign({ tenant_id: 'dashboard-a', tenant_user_id: 'dashboard-human', ambiente: 'teste', role: 'TRANSPORTADOR' }, secret, { expiresIn: '1h' });
        const response = await fetch(base, { headers: { authorization: `Bearer ${humanToken}` } });
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.stats.periodo.mes).toBe('2026-09');
        expect(body.stats.total_averbacoes).toBe(1);
      } finally {
        jest.setSystemTime(now);
      }
    });
  });

  test.each(['2026-00', '2026-13', '2026-1', 'abcd-12', '', '2026-01&mes=2026-02'])('rejects invalid month %s', async (month) => {
    await withFixture(async () => {
      expect((await read(`?mes=${month}`)).status).toBe(400);
    });
  });

  test('requires authentication and activated tenant', async () => {
    await withFixture(async () => {
      expect((await fetch(base)).status).toBe(401);
      expect((await read('', 'dashboard-inactive')).status).toBe(403);
      expect((await read('', 'missing-tenant')).status).toBe(404);
    });
  });
});
