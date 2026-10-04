import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import authRoutes from './auth';
import portalIdentityRoutes from './portalIdentity';
import { authMiddleware } from '../middleware/authMiddleware';
import { dbStore } from '../services/dbStore';
import { PortalIdentityService } from '../services/portalIdentityService';
import { getJwtSecret } from '../utils/jwtSecret';
import { Tenant, TenantUser } from '../types';

// Credential/session regression kept separately from the onboarding patch and its PR.
jest.mock('../services/dbStore', () => ({
  dbStore: { tenants: [], tenantUsers: [], responseTemplates: [], persist: jest.fn() }
}));
jest.mock('../utils/jwtSecret', () => {
  const secret = require('crypto').randomBytes(32).toString('hex');
  return { getJwtSecret: () => secret };
});
jest.mock('../services/portalIdentityService', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arkatech-clock-fixtures-'));
  try { return jest.requireActual('../services/portalIdentityService'); }
  finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
});
jest.mock('../services/portalIdentityEmailService', () => ({
  sendPortalPasswordResetEmail: jest.fn(async () => ({ enviado: true }))
}));

describe('portal reset millisecond / JWT second boundary (isolated diagnostic)', () => {
  let server: Server;
  let baseUrl: string;
  let user: TenantUser;
  let newPassword: string;
  let preResetToken: string;
  let legacySameSecondToken: string;
  const secondStart = Date.parse('2030-01-01T00:00:00.000Z');

  async function post(path: string, body: unknown) {
    const response = await fetch(baseUrl + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as any };
  }

  async function protectedStatus(token: string) {
    return (await fetch(baseUrl + '/protected', { headers: { Authorization: `Bearer ${token}` } })).status;
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/auth', portalIdentityRoutes);
    app.use('/auth', authRoutes);
    app.get('/protected', authMiddleware, (_req, res) => res.json({ status: 'sucesso' }));
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(async () => {
    // Freeze Date only; real timers preserve bcrypt, HTTP and cleanup progress.
    jest.useFakeTimers({
      now: secondStart - 1_000,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime']
    });
    const oldPassword = crypto.randomBytes(24).toString('base64url');
    user = {
      id: crypto.randomUUID(), tenant_id: 'synthetic-clock', nome: 'Synthetic clock user',
      email: `${crypto.randomUUID()}@example.invalid`, status: 'ATIVO', is_admin_da_conta: true,
      password_hash: await bcrypt.hash(oldPassword, 4), created_at: new Date().toISOString()
    };
    dbStore.tenantUsers = [user];
    dbStore.tenants = [{ id: user.tenant_id, role: 'TRANSPORTADOR', token_duration_hours: 1 } as Tenant];
    const reset = PortalIdentityService.createPasswordReset(user.email)!;
    newPassword = crypto.randomBytes(24).toString('base64url');
    jest.setSystemTime(secondStart + 100);
    const beforeReset = await post('/auth/portal-login', { email: user.email, senha: oldPassword });
    expect(beforeReset.status).toBe(200);
    preResetToken = beforeReset.body.empresas[0].access_token;
    legacySameSecondToken = jwt.sign({ tenant_id: user.tenant_id, tenant_user_id: user.id }, getJwtSecret());
    expect(await protectedStatus(preResetToken)).toBe(200);
    expect(await protectedStatus(legacySameSecondToken)).toBe(200);
    jest.setSystemTime(secondStart + 500);
    expect((await post(`/auth/portal-password/reset/${reset.token}`, { senha: newPassword })).status).toBe(200);
    expect(PortalIdentityService._debugRecords().find(record => record.target_user_ids.includes(user.id))!.used_at)
      .toBe('2030-01-01T00:00:00.500Z');
  });

  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('rejects a session issued before reset', async () => {
    const oldToken = jwt.sign({ tenant_id: user.tenant_id, tenant_user_id: user.id, iat: secondStart / 1000 - 1 }, getJwtSecret());
    expect(await protectedStatus(oldToken)).toBe(401);
  });

  it('revokes both new-format and legacy tokens issued earlier in the reset second', async () => {
    expect(await protectedStatus(preResetToken)).toBe(401);
    expect(await protectedStatus(legacySameSecondToken)).toBe(401);
  });

  it('should accept a new login at .800 after the reset completed at .500 in the same second', async () => {
    jest.setSystemTime(secondStart + 800);
    const login = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    expect(login.status).toBe(200);
    const newToken = login.body.empresas[0].access_token;
    const claims = jwt.verify(newToken, getJwtSecret()) as jwt.JwtPayload;
    expect(claims.iat).toBe(secondStart / 1000);
    expect(claims.portal_session_version).toMatch(/^[a-f0-9]{64}$/);
    expect(claims.portal_session_version).not.toContain(user.password_hash);
    expect(await protectedStatus(newToken)).toBe(200);
  });

  it('accepts a new login in the following second', async () => {
    jest.setSystemTime(secondStart + 1_100);
    const login = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    expect(login.status).toBe(200);
    expect(await protectedStatus(login.body.empresas[0].access_token)).toBe(200);
  });

  it('preserves a legacy session issued after the reset in a later second', async () => {
    jest.setSystemTime(secondStart + 1_100);
    const legacy = jwt.sign({ tenant_id: user.tenant_id, tenant_user_id: user.id }, getJwtSecret());
    expect(await protectedStatus(legacy)).toBe(200);
  });

  it('rejects a legacy session with no issuance time after a reset', async () => {
    const legacy = jwt.sign({ tenant_id: user.tenant_id, tenant_user_id: user.id }, getJwtSecret(), { noTimestamp: true });
    expect(await protectedStatus(legacy)).toBe(401);
  });

  it('keeps M2M authentication independent of a human password reset', async () => {
    const machine = jwt.sign({ tenant_id: user.tenant_id, role: 'TRANSPORTADOR' }, getJwtSecret());
    expect(await protectedStatus(machine)).toBe(200);
  });

  it('does not revive a legacy token when reset history older than 30 days is pruned', async () => {
    const otherUser = { ...user, id: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.invalid` };
    dbStore.tenantUsers.push(otherUser);
    jest.setSystemTime(secondStart + 31 * 86_400_000);
    expect(PortalIdentityService.createPasswordReset(otherUser.email)).toBeDefined();
    expect(PortalIdentityService._debugRecords().some(record => record.used_at && record.target_user_ids.includes(user.id))).toBe(true);
    expect(await protectedStatus(legacySameSecondToken)).toBe(401);
  });

  it('rejects a version from another user/tenant even when password hashes match', async () => {
    const login = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    const claims = jwt.verify(login.body.empresas[0].access_token, getJwtSecret()) as jwt.JwtPayload;
    const otherUser = { ...user, id: crypto.randomUUID(), tenant_id: 'other-synthetic-tenant' };
    dbStore.tenantUsers.push(otherUser);
    const mismatched = jwt.sign({
      tenant_id: otherUser.tenant_id, tenant_user_id: otherUser.id,
      portal_session_version: claims.portal_session_version
    }, getJwtSecret());
    expect(await protectedStatus(mismatched)).toBe(401);
  });

  it('rejects a malformed version without falling back to the legacy timestamp', async () => {
    jest.setSystemTime(secondStart + 1_100);
    const malformed = jwt.sign({ tenant_id: user.tenant_id, tenant_user_id: user.id, portal_session_version: [] }, getJwtSecret());
    expect(await protectedStatus(malformed)).toBe(401);
  });

  it('revokes a session on a second password reset in the exact same millisecond', async () => {
    const login = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    const beforeSecondReset = login.body.empresas[0].access_token;
    expect(await protectedStatus(beforeSecondReset)).toBe(200);
    const reset = PortalIdentityService.createPasswordReset(user.email)!;
    expect((await post(`/auth/portal-password/reset/${reset.token}`, { senha: newPassword })).status).toBe(200);
    expect(await protectedStatus(beforeSecondReset)).toBe(401);
    const after = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    expect(await protectedStatus(after.body.empresas[0].access_token)).toBe(200);
  });

  it('revokes a legacy token when reset completes exactly at its whole-second timestamp', async () => {
    jest.setSystemTime(secondStart + 1_000);
    const legacy = jwt.sign({ tenant_id: user.tenant_id, tenant_user_id: user.id }, getJwtSecret());
    expect(await protectedStatus(legacy)).toBe(200);
    const reset = PortalIdentityService.createPasswordReset(user.email)!;
    expect((await post(`/auth/portal-password/reset/${reset.token}`, { senha: newPassword })).status).toBe(200);
    expect(await protectedStatus(legacy)).toBe(401);
    const after = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    expect(await protectedStatus(after.body.empresas[0].access_token)).toBe(200);
  });

  it('does not authenticate an outdated password when reset completes during bcrypt verification', async () => {
    const reset = PortalIdentityService.createPasswordReset(user.email)!;
    const replacement = crypto.randomBytes(24).toString('base64url');
    const compare = bcrypt.compare.bind(bcrypt);
    jest.spyOn(bcrypt, 'compare').mockImplementationOnce((async (password: string, hash: string) => {
      const valid = await compare(password, hash);
      await PortalIdentityService.consume(reset.token, replacement);
      return valid;
    }) as any);
    const overlapping = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    expect(overlapping.status).toBe(401);
    expect(overlapping.body).not.toHaveProperty('empresas');
    const current = await post('/auth/portal-login', { email: user.email, senha: replacement });
    expect(await protectedStatus(current.body.empresas[0].access_token)).toBe(200);
  });

  it('revokes all multi-company memberships and accepts new versions after mailbox reset', async () => {
    const otherUser = { ...user, id: crypto.randomUUID(), tenant_id: 'other-synthetic-tenant' };
    dbStore.tenantUsers.push(otherUser);
    dbStore.tenants.push({ id: otherUser.tenant_id, role: 'TRANSPORTADOR', token_duration_hours: 1 } as Tenant);
    const before = await post('/auth/portal-login', { email: user.email, senha: newPassword });
    expect(before.body.empresas).toHaveLength(2);
    const versions = before.body.empresas.map((item: any) => (jwt.verify(item.access_token, getJwtSecret()) as jwt.JwtPayload).portal_session_version);
    expect(versions[0]).not.toBe(versions[1]);
    const reset = PortalIdentityService.createPasswordReset(user.email)!;
    const replacement = crypto.randomBytes(24).toString('base64url');
    expect((await post(`/auth/portal-password/reset/${reset.token}`, { senha: replacement })).status).toBe(200);
    for (const company of before.body.empresas) expect(await protectedStatus(company.access_token)).toBe(401);
    const after = await post('/auth/portal-login', { email: user.email, senha: replacement });
    expect(after.body.empresas).toHaveLength(2);
    for (const company of after.body.empresas) expect(await protectedStatus(company.access_token)).toBe(200);
  });
});
