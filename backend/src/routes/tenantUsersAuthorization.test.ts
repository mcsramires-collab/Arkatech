import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { dbStore } from '../services/dbStore';
import { TenantUser } from '../types';
import tenantRoutes from './tenant';
import tenantIdentityRoutes from './tenantIdentity';
import { sendPortalUserInviteEmail } from '../services/portalIdentityEmailService';

// In-memory fixtures only: never load the real store, persist data or send email.
jest.mock('../services/dbStore', () => ({
  dbStore: { tenantUsers: [], tenants: [], responseTemplates: [], persist: jest.fn() }
}));
jest.mock('../utils/jwtSecret', () => {
  const secret = require('crypto').randomBytes(32).toString('hex');
  return { getJwtSecret: () => secret };
});
jest.mock('../services/portalIdentityService', () => ({
  PortalIdentityService: {
    isPortalSessionStale: jest.fn(() => false),
    createUserInvite: jest.fn(() => ({ token: 'synthetic-invite', expires_at: '2030-01-01' }))
  }
}));
jest.mock('../services/portalIdentityEmailService', () => ({
  sendPortalUserInviteEmail: jest.fn(async () => ({ enviado: true }))
}));

import { getJwtSecret } from '../utils/jwtSecret';

describe('tenant user management authorization (synthetic HTTP fixtures)', () => {
  let server: Server;
  let baseUrl: string;
  const createdAt = '2026-01-01T00:00:00.000Z';

  function user(id: string, tenantId: string, admin = false): TenantUser {
    return {
      id, tenant_id: tenantId, nome: id, email: `${id}@example.invalid`,
      password_hash: 'synthetic-unused-hash', is_admin_da_conta: admin,
      status: 'ATIVO', created_at: createdAt
    };
  }

  function token(claims: Record<string, unknown> = {}): string {
    return jwt.sign({
      tenant_id: 'tenant-a', role: 'TRANSPORTADOR', ambiente: 'teste',
      ...claims
    }, getJwtSecret(), { expiresIn: '5m' });
  }

  function adminToken(): string {
    return token({ tenant_user_id: 'admin-a', is_admin_da_conta: true });
  }

  async function request(method: string, path: string, bearer?: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() as any };
  }

  const mutations = [
    ['POST', '/users', { nome: 'New user', email: 'new@example.invalid', is_admin_da_conta: true, rbac_profile_id: 'profile-a' }],
    ['PUT', '/users/operator-a', { is_admin_da_conta: true, rbac_profile_id: 'profile-a' }],
    ['DELETE', '/users/operator-a', undefined]
  ] as const;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Same router order as server.ts; importing the server would start real services.
    app.use('/api/v1/tenant', tenantIdentityRoutes);
    app.use('/api/v1/tenant', tenantRoutes);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tenant`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    dbStore.tenantUsers = [
      user('admin-a', 'tenant-a', true), user('operator-a', 'tenant-a'),
      user('admin-b', 'tenant-b', true), user('operator-b', 'tenant-b')
    ];
    // Only the invite flow needs the tenant's display name.
    dbStore.tenants = [{ id: 'tenant-a', razao_social: 'Synthetic A', role: 'TRANSPORTADOR' } as any];
    jest.clearAllMocks();
  });

  describe.each([
    ['non-admin', { tenant_user_id: 'operator-a', is_admin_da_conta: false }],
    ['non-admin with admin claim', { tenant_user_id: 'operator-a', is_admin_da_conta: true }],
    ['M2M', {}],
    ['M2M with admin claim', { is_admin_da_conta: true }],
    ['backoffice ADM', { actor_type: 'INTERNAL_USER', user_id: 'synthetic-internal', role: 'ADM' }]
  ])('%s', (_label, claims) => {
    it.each(mutations)('denies %s %s without changing users', async (method, path, body) => {
      const before = structuredClone(dbStore.tenantUsers);
      const result = await request(method, path, token(claims), body);
      expect(result.status).toBe(403);
      expect(dbStore.tenantUsers).toEqual(before);
      expect(dbStore.persist).not.toHaveBeenCalled();
    });
  });

  it('denies a non-admin editing ordinary fields as well as permissions', async () => {
    const result = await request('PUT', '/users/admin-a', token({ tenant_user_id: 'operator-a' }), {
      nome: 'Changed', email: 'changed@example.invalid', status: 'INATIVO'
    });
    expect(result.status).toBe(403);
    expect(dbStore.tenantUsers[0]).toMatchObject({ nome: 'admin-a', status: 'ATIVO' });
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it.each(mutations)('denies a demoted admin with an old token: %s %s', async (method, path, body) => {
    const oldToken = adminToken();
    dbStore.tenantUsers[0].is_admin_da_conta = false;
    const before = structuredClone(dbStore.tenantUsers);
    expect((await request(method, path, oldToken, body)).status).toBe(403);
    expect(dbStore.tenantUsers).toEqual(before);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it.each(['INATIVO', 'removed'])('rejects an %s admin via real authMiddleware', async state => {
    const oldToken = adminToken();
    if (state === 'removed') dbStore.tenantUsers.shift();
    else dbStore.tenantUsers[0].status = 'INATIVO';
    expect((await request('PUT', '/users/operator-a', oldToken, { is_admin_da_conta: true })).status).toBe(401);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it.each(mutations)('requires authentication: %s %s', async (method, path, body) => {
    expect((await request(method, path, undefined, body)).status).toBe(401);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it('rejects an identity belonging to a different tenant', async () => {
    const mismatched = token({ tenant_user_id: 'admin-b', is_admin_da_conta: true });
    expect((await request('PUT', '/users/operator-a', mismatched, { is_admin_da_conta: true })).status).toBe(401);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'DELETE'])('returns 404 for another tenant target: %s', async method => {
    const before = structuredClone(dbStore.tenantUsers);
    const result = await request(method, '/users/operator-b?tenant_id=tenant-b', adminToken(), {
      tenant_id: 'tenant-b', is_admin_da_conta: true, rbac_profile_id: 'profile-b'
    });
    expect(result.status).toBe(404);
    expect(dbStore.tenantUsers).toEqual(before);
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it('allows admin creation only in the token tenant and keeps password hashes private', async () => {
    const result = await request('POST', '/users?tenant_id=tenant-b', adminToken(), {
      tenant_id: 'tenant-b', nome: 'New admin', email: 'new@example.invalid',
      is_admin_da_conta: true, rbac_profile_id: 'profile-a'
    });
    expect(result.status).toBe(200);
    expect(result.body.user).toMatchObject({ tenant_id: 'tenant-a', is_admin_da_conta: true, rbac_profile_id: 'profile-a' });
    expect(result.body.user).not.toHaveProperty('password_hash');
    const created = dbStore.tenantUsers.find(item => item.id === result.body.user.id)!;
    expect(await bcrypt.compare(result.body.senha_temporaria, created.password_hash)).toBe(true);
    expect(dbStore.persist).toHaveBeenCalledTimes(1);
    expect(dbStore.tenantUsers.filter(item => item.tenant_id === 'tenant-b')).toHaveLength(2);
  });

  it('allows admin promotion/profile editing in the same tenant', async () => {
    const result = await request('PUT', '/users/operator-a', adminToken(), {
      tenant_id: 'tenant-b', is_admin_da_conta: true, rbac_profile_id: 'profile-a', nome: 'Promoted'
    });
    expect(result.status).toBe(200);
    expect(result.body.user).toMatchObject({ tenant_id: 'tenant-a', is_admin_da_conta: true, rbac_profile_id: 'profile-a', nome: 'Promoted' });
    expect(result.body.user).not.toHaveProperty('password_hash');
    expect(dbStore.persist).toHaveBeenCalledTimes(1);
  });

  it('allows admin deletion in the same tenant', async () => {
    expect((await request('DELETE', '/users/operator-a', adminToken())).status).toBe(200);
    expect(dbStore.tenantUsers.map(item => item.id)).toEqual(['admin-a', 'admin-b', 'operator-b']);
    expect(dbStore.persist).toHaveBeenCalledTimes(1);
  });

  it.each(['/users/invite', '/users/operator-a/resend-invite'])('denies demoted admins on %s too', async path => {
    const oldToken = adminToken();
    dbStore.tenantUsers[0].is_admin_da_conta = false;
    const before = structuredClone(dbStore.tenantUsers);
    expect((await request('POST', path, oldToken, { nome: 'Invite', email: 'invite@example.invalid' })).status).toBe(403);
    expect(dbStore.tenantUsers).toEqual(before);
    expect(dbStore.persist).not.toHaveBeenCalled();
    expect(sendPortalUserInviteEmail).not.toHaveBeenCalled();
  });

  it('preserves legitimate admin invitation and resend flows without sending real email', async () => {
    const invite = await request('POST', '/users/invite', adminToken(), {
      nome: 'Invited', email: 'invite@example.invalid', is_admin_da_conta: false
    });
    expect(invite.status).toBe(201);
    expect(invite.body.user).toMatchObject({ tenant_id: 'tenant-a', status: 'INATIVO' });
    expect(invite.body.user).not.toHaveProperty('password_hash');
    expect((await request('POST', `/users/${invite.body.user.id}/resend-invite`, adminToken())).status).toBe(200);
    expect(sendPortalUserInviteEmail).toHaveBeenCalledTimes(2);
  });
});
