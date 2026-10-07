import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import app from '../server';
import { dbStore } from '../services/dbStore';
import { calcularStatusCadastro } from '../routes/adminPacote2109';
import type { Policy, RbacPermissionLevel } from '../types';

const jwtSecret = crypto.randomBytes(32).toString('hex');
const internalKey = crypto.randomBytes(32).toString('hex');
const savedEnv = { JWT_SECRET: process.env.JWT_SECRET, INTERNAL_API_KEY: process.env.INTERNAL_API_KEY };
const existingBounds = { suspensa_desde: '2026-01-01', suspensa_ate: '2026-01-02' };

interface RequestOptions {
  policyId?: string;
  profile?: string;
  actor?: Record<string, unknown>;
  anonymous?: boolean;
  internal?: boolean;
  method?: 'POST' | 'DELETE';
}

async function withSuspensionApi(
  check: (
    request: (body?: Record<string, unknown>, options?: RequestOptions) => Promise<{ status: number; body: any }>,
    persist: jest.SpyInstance
  ) => Promise<void>
) {
  await dbStore.runTestLabEphemeral(async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    dbStore.policies = ['a', 'b'].map((id): Policy => ({
      id: `policy-${id}`, numero_apolice: `POL-${id}`, ramo: 'RCTRC', tenant_id: 'tenant-shared',
      insurer_id: `insurer-${id}`, broker_id: 'broker-test', status: 'ATIVA',
      vigencia_inicio: '2020-01-01', vigencia_fim: '2100-01-01',
      permitir_inativo_vencido: false, aceita_averbacao_como_destinatario: false,
      ...existingBounds
    }));
    dbStore.rbacProfiles = (['editar', 'ver', 'sem_acesso'] as RbacPermissionLevel[]).map((level) => ({
      id: level, owner_type: 'SEGURADORA', owner_id: 'insurer-a', nome_perfil: level, created_at: timestamp,
      permissions: {
        apolices: level, clientes: 'sem_acesso', coberturas: 'sem_acesso', relatorios: 'sem_acesso',
        usuarios: 'sem_acesso', delegacao_corretora: 'sem_acesso'
      }
    }));
    dbStore.revokedTokens = [];
    const persist = jest.spyOn(dbStore, 'persist');
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/policies`;
    try {
      await check(async (body, options = {}) => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (options.internal) headers['x-internal-api-key'] = internalKey;
        else if (!options.anonymous) {
          const token = jwt.sign({
            actor_type: 'SEGURADORA', user_id: 'suspension-user', nome: 'Suspension Test',
            email: 'suspension@example.test', role: 'SEGURADORA', insurer_id: 'insurer-a',
            rbac_profile_id: options.profile ?? 'editar', ...options.actor
          }, jwtSecret, { expiresIn: 3600 });
          headers.authorization = `Bearer ${token}`;
        }
        const response = await fetch(`${base}/${options.policyId ?? 'policy-a'}/suspensao`, {
          method: options.method ?? 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
      }, persist);
    } finally {
      persist.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

describe('Policy suspension HTTP contracts', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = jwtSecret;
    process.env.INTERNAL_API_KEY = internalKey;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test.each([
    { desde: '2028-02-29', ate: '2028-03-01' },
    { desde: '2000-02-29T00:00:00Z', ate: '2000-02-29T00:00:00.001Z' },
    { desde: '2026-10-07T12:00:00-03:00', ate: '2026-10-07T15:00:00Z' },
    { desde: '2026-10-07T15:00:00+03:00', ate: '2026-10-07T13:00:00Z' },
    { desde: '2026-10-07T23:30:00-03:00', ate: '2026-10-08T02:30:00.999Z' },
    { desde: '2026-10-07T00:00:00.1Z', ate: '2026-10-07T00:00:00.10Z' },
    { desde: '1970-01-01', ate: '1970-01-01T00:00:00Z' },
    { desde: '2026-10-07', ate: '2026-10-07' }
  ])('accepts valid inclusive instants without rewriting them: $desde to $ate', async (body) => {
    await withSuspensionApi(async (request, persist) => {
      const otherPolicy = structuredClone(dbStore.policies[1]);
      const response = await request(body);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('sucesso');
      expect(response.body.policy).toMatchObject({ suspensa_desde: body.desde, suspensa_ate: body.ate });
      expect(dbStore.policies[0]).toMatchObject({ suspensa_desde: body.desde, suspensa_ate: body.ate });
      expect(dbStore.policies[1]).toEqual(otherPolicy);
      expect(persist).toHaveBeenCalledTimes(1);
    });
  });

  test.each([
    ['omitted', undefined], ['null', null], ['empty string', '']
  ])('accepts an open-ended suspension with %s end and clears the old end', async (_name, ate) => {
    await withSuspensionApi(async (request, persist) => {
      const response = await request({ desde: '2026-10-07T15:00:00.000Z', ate });
      expect(response.status).toBe(200);
      expect(response.body.policy.suspensa_ate).toBeUndefined();
      expect(dbStore.policies[0].suspensa_ate).toBeUndefined();
      expect(persist).toHaveBeenCalledTimes(1);
    });
  });

  const invalidDates: Array<[string, unknown]> = [
    ['text', 'not-a-date'], ['whitespace', ' '], ['padded', ' 2026-10-07 '],
    ['number', 1791331200000], ['zero', 0], ['true', true], ['false', false],
    ['object', {}], ['array', ['2026-10-07']], ['empty array', []],
    ['locale date', '10/07/2026'], ['non-padded date', '2026-1-1'], ['month-only', '2026-10'],
    ['February rollover', '2026-02-30'], ['non-leap February', '2026-02-29'],
    ['non-leap century', '2100-02-29'], ['April rollover', '2026-04-31'],
    ['month 13', '2026-13-01'], ['day zero', '2026-10-00'],
    ['invalid calendar with offset', '2026-02-30T23:00:00-03:00'],
    ['missing timezone', '2026-10-07T15:00:00'], ['space separator', '2026-10-07 15:00:00Z'],
    ['hour rollover', '2026-10-07T24:00:00Z'], ['minute rollover', '2026-10-07T12:60:00Z'],
    ['leap second', '2026-10-07T12:00:60Z'], ['invalid offset', '2026-10-07T12:00:00+24:00'],
    ['invalid offset minutes', '2026-10-07T12:00:00+03:60'],
    ['sub-millisecond precision', '2026-10-07T12:00:00.0001Z']
  ];

  test.each(invalidDates)('rejects %s in either bound without mutating or persisting', async (_name, value) => {
    await withSuspensionApi(async (request, persist) => {
      const snapshot = structuredClone(dbStore.policies);
      for (const body of [{ desde: value }, { desde: '2026-10-01', ate: value }]) {
        const response = await request(body);
        expect(response.status).toBe(400);
        expect(response.body.status).toBe('erro');
        expect(dbStore.policies).toEqual(snapshot);
        expect(persist).not.toHaveBeenCalled();
      }
    });
  });

  test.each([undefined, {}, { desde: null }, { desde: '' }])('requires desde: %j', async (body) => {
    await withSuspensionApi(async (request, persist) => {
      const snapshot = structuredClone(dbStore.policies);
      const response = await request(body);
      expect(response.status).toBe(400);
      expect(response.body.mensagem).toContain('desde é obrigatório');
      expect(dbStore.policies).toEqual(snapshot);
      expect(persist).not.toHaveBeenCalled();
    });
  });

  test.each([
    { desde: '2026-10-08', ate: '2026-10-07' },
    { desde: '2026-10-07T12:00:00-03:00', ate: '2026-10-07T14:59:59.999Z' },
    { desde: '2026-10-07T00:00:00.001Z', ate: '2026-10-07' }
  ])('rejects reversed instants: $desde to $ate', async (body) => {
    await withSuspensionApi(async (request, persist) => {
      const snapshot = structuredClone(dbStore.policies);
      const response = await request(body);
      expect(response.status).toBe(400);
      expect(response.body.mensagem).toContain('igual ou posterior');
      expect(dbStore.policies).toEqual(snapshot);
      expect(persist).not.toHaveBeenCalled();
    });
  });

  test('date-only remains midnight UTC at both inclusive boundaries', async () => {
    await withSuspensionApi(async (request) => {
      expect((await request({ desde: '2026-10-07', ate: '2026-10-07' })).status).toBe(200);
      const tenant = { status: 'ATIVO' } as Parameters<typeof calcularStatusCadastro>[0];
      const now = jest.spyOn(Date, 'now');
      try {
        now.mockReturnValue(Date.parse('2026-10-06T23:59:59.999Z'));
        expect(calcularStatusCadastro(tenant, [dbStore.policies[0]])).toBe('ATIVO');
        now.mockReturnValue(Date.parse('2026-10-07T00:00:00.000Z'));
        expect(calcularStatusCadastro(tenant, [dbStore.policies[0]])).toBe('SEM_APOLICES_VIGENTES');
        now.mockReturnValue(Date.parse('2026-10-07T00:00:00.001Z'));
        expect(calcularStatusCadastro(tenant, [dbStore.policies[0]])).toBe('ATIVO');
      } finally {
        now.mockRestore();
      }
    });
  });

  const deniedRequests: Array<[string, number, RequestOptions]> = [
    ['unauthenticated', 401, { anonymous: true }],
    ['read-only RBAC', 403, { profile: 'ver' }],
    ['no-access RBAC', 403, { profile: 'sem_acesso' }],
    ['missing RBAC profile', 403, { profile: 'missing' }],
    ['unassigned RBAC profile', 403, { actor: { rbac_profile_id: undefined } }],
    ['cross-insurer policy', 403, { policyId: 'policy-b' }],
    ['insurer without binding', 403, { actor: { insurer_id: undefined } }],
    ['broker actor', 403, { actor: { actor_type: 'CORRETORA', role: 'CORRETORA' } }],
    ['missing policy', 404, { policyId: 'missing' }]
  ];

  test.each(deniedRequests)('preserves %s guard before validating or mutating', async (_name, expectedStatus, options) => {
    await withSuspensionApi(async (request, persist) => {
      const snapshot = structuredClone(dbStore.policies);
      // Neither valid nor invalid input may bypass auth/RBAC/scope. A supplied
      // insurer_id must not override the policy ownership derived from the actor.
      for (const desde of ['2026-10-07', 'bad-date']) {
        const response = await request({ desde, insurer_id: 'insurer-a' }, options);
        expect(response.status).toBe(expectedStatus);
        expect(dbStore.policies).toEqual(snapshot);
        expect(persist).not.toHaveBeenCalled();
      }
    });
  });

  test('keeps internal administration access and DELETE reactivation unchanged', async () => {
    await withSuspensionApi(async (request, persist) => {
      expect((await request({ desde: '2026-10-07' }, { internal: true, policyId: 'policy-b' })).status).toBe(200);
      expect((await request(undefined, { method: 'DELETE' })).status).toBe(200);
      expect(dbStore.policies[0].suspensa_desde).toBeUndefined();
      expect(dbStore.policies[0].suspensa_ate).toBeUndefined();
      expect(persist).toHaveBeenCalledTimes(2);
    });
  });
});
