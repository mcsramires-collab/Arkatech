import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { dbStore } from '../services/dbStore';
import { ActivationToken, Tenant } from '../types';
import tenantRoutes from './tenant';
import authRoutes from './auth';

// Only synthetic in-memory entities; no persisted store, real credentials or email.
jest.mock('../services/dbStore', () => ({
  dbStore: { tenants: [], activationTokens: [], tenantUsers: [], responseTemplates: [], persist: jest.fn() }
}));
jest.mock('../services/portalIdentityService', () => ({
  PortalIdentityService: { isPortalSessionStale: jest.fn(() => false) }
}));
jest.mock('../utils/jwtSecret', () => {
  const secret = require('crypto').randomBytes(32).toString('hex');
  return { getJwtSecret: () => secret };
});

describe('public activation status privacy (synthetic HTTP fixtures)', () => {
  let server: Server;
  let baseUrl: string;
  let invite: ActivationToken;
  let otherInvite: ActivationToken;

  function tenant(id: string): Tenant {
    return {
      id, cnpj: '12ABC34501DE90', razao_social: `Synthetic ${id}`,
      status: 'ATIVO', ambiente: 'teste', role: 'TRANSPORTADOR',
      client_id: `synthetic-client-${id}`, client_secret_hash: `synthetic-private-${id}`,
      conta_ativada: false, token_duration_hours: 1, created_at: '2026-01-01T00:00:00Z'
    };
  }

  function activation(tenantId: string): ActivationToken {
    return {
      id: `invite-${tenantId}`, tenant_id: tenantId,
      token: crypto.randomBytes(32).toString('base64url'), termo_versao: 'v-fixture',
      aceite: false, expira_em: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: '2026-01-01T00:00:00Z', convite_nome: 'Synthetic invited user',
      convite_email: `${tenantId}@example.invalid`
    };
  }

  async function request(path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() as any };
  }

  function expectPublicOnly(body: unknown) {
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(invite.token);
    expect(serialized).not.toContain(otherInvite.token);
    for (const item of dbStore.tenants) {
      expect(serialized).not.toContain(item.client_secret_hash);
      expect(serialized).not.toContain(item.client_id);
    }
    expect(serialized).not.toMatch(/token|secret|password|convite_email|convite_nome/i);
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/tenant', tenantRoutes);
    app.use('/auth', authRoutes);
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    dbStore.tenants = [tenant('tenant-a'), tenant('tenant-b')];
    invite = activation('tenant-a');
    otherInvite = activation('tenant-b');
    dbStore.activationTokens = [otherInvite, invite];
    dbStore.tenantUsers = [];
    jest.clearAllMocks();
  });

  it.each(['tenant-a', 'tenant-b'])('returns only activation state and terms for %s without authentication', async tenantId => {
    const before = structuredClone({ tenants: dbStore.tenants, invites: dbStore.activationTokens });
    const result = await request(`/tenant/activation-status?tenant_id=${tenantId}`);
    expect(result.status).toBe(200);
    expectPublicOnly(result.body);
    expect(result.body).toEqual({ status: 'sucesso', conta_ativada: false, termo_versao: 'v-fixture' });
    expect({ tenants: dbStore.tenants, invites: dbStore.activationTokens }).toEqual(before);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it('returns safe state when no pending invite exists', async () => {
    dbStore.activationTokens = [];
    const result = await request('/tenant/activation-status?tenant_id=tenant-a');
    expect(result.status).toBe(200);
    expectPublicOnly(result.body);
    expect(result.body).toEqual({ status: 'sucesso', conta_ativada: false });
  });

  it('returns safe state for an already activated account', async () => {
    dbStore.tenants[0].conta_ativada = true;
    invite.aceite = true;
    const result = await request('/tenant/activation-status?tenant_id=tenant-a');
    expect(result.status).toBe(200);
    expectPublicOnly(result.body);
    expect(result.body).toEqual({ status: 'sucesso', conta_ativada: true });
  });

  it('does not disclose an expired pending invitation', async () => {
    invite.expira_em = '2000-01-01T00:00:00Z';
    const result = await request('/tenant/activation-status?tenant_id=tenant-a');
    expect(result.status).toBe(200);
    expectPublicOnly(result.body);
    expect(result.body).toEqual({ status: 'sucesso', conta_ativada: false, termo_versao: 'v-fixture' });
  });

  it.each(['', 'unknown'])('retains 404 for missing or unknown tenant: %s', async tenantId => {
    const result = await request(`/tenant/activation-status?tenant_id=${tenantId}`);
    expect(result.status).toBe(404);
    expectPublicOnly(result.body);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it('preserves an invitation received through the existing link, first password and login', async () => {
    const details = await request(`/tenant/activation/${invite.token}`);
    expect(details.status).toBe(200);
    expect(details.body.convite).toMatchObject({ cnpj: '12ABC34501DE90', ja_aceito: false, expirado: false });
    const password = crypto.randomBytes(24).toString('base64url');
    const accepted = await request(`/tenant/activation/${invite.token}/definir-senha`, { senha: password });
    expect(accepted.status).toBe(200);
    expect(accepted.body.user).not.toHaveProperty('password_hash');
    expect(accepted.body.tenant).toMatchObject({ id: 'tenant-a', cnpj: '12ABC34501DE90' });
    expect(invite.aceite).toBe(true);
    expect(otherInvite.aceite).toBe(false);
    expect(dbStore.tenants[1].conta_ativada).toBe(false);
    expect(await bcrypt.compare(password, dbStore.tenantUsers[0].password_hash)).toBe(true);
    const status = await request('/tenant/activation-status?tenant_id=tenant-a');
    expectPublicOnly(status.body);
    expect(status.body).toEqual({ status: 'sucesso', conta_ativada: true });
    const login = await request('/auth/portal-login', { email: invite.convite_email, senha: password });
    expect(login.status).toBe(200);
    expect(login.body.empresas.map((item: any) => item.tenant_id)).toEqual(['tenant-a']);
    expect((await request(`/tenant/activation/${invite.token}/definir-senha`, { senha: password })).status).toBe(400);
    expect(dbStore.persist).toHaveBeenCalledTimes(1);
  });

  it('preserves terms acceptance with an already received valid invitation', async () => {
    expect((await request(`/tenant/activation/${invite.token}/aceitar`, {})).status).toBe(200);
    expect(invite.aceite).toBe(true);
    expect(dbStore.tenants[0].conta_ativada).toBe(true);
    expect(dbStore.tenants[1].conta_ativada).toBe(false);
  });

  it.each(['expired', 'unknown'])('does not activate an account through an %s invitation', async state => {
    if (state === 'expired') invite.expira_em = '2000-01-01T00:00:00Z';
    const token = state === 'unknown' ? 'synthetic-unknown' : invite.token;
    const result = await request(`/tenant/activation/${token}/definir-senha`, { senha: crypto.randomUUID() });
    expect(result.status).toBe(state === 'expired' ? 400 : 404);
    expect(dbStore.tenantUsers).toEqual([]);
    expect(dbStore.tenants[0].conta_ativada).toBe(false);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });
});
