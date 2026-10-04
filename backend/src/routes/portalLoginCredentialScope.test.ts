import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dbStore } from '../services/dbStore';
import { PortalIdentityService } from '../services/portalIdentityService';
import { getJwtSecret } from '../utils/jwtSecret';
import authRoutes from './auth';
import tenantRoutes from './tenant';
import tenantIdentityRoutes from './tenantIdentity';
import portalIdentityRoutes from './portalIdentity';
import { Tenant, TenantUser } from '../types';

jest.mock('../services/dbStore', () => ({
  dbStore: { tenantUsers: [], tenants: [], responseTemplates: [], persist: jest.fn() }
}));
jest.mock('../utils/jwtSecret', () => {
  const secret = require('crypto').randomBytes(32).toString('hex');
  return { getJwtSecret: () => secret };
});
// Exercise real invite/reset semantics with storage confined to fresh synthetic fixtures.
jest.mock('../services/portalIdentityService', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arkatech-identity-fixtures-'));
  try {
    return jest.requireActual('../services/portalIdentityService');
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
  }
});
jest.mock('../services/portalIdentityEmailService', () => ({
  sendPortalUserInviteEmail: jest.fn(async () => ({ enviado: true })),
  sendPortalPasswordResetEmail: jest.fn(async () => ({ enviado: true }))
}));

describe('portal login credential scope (synthetic HTTP fixtures)', () => {
  let server: Server;
  let baseUrl: string;
  let email: string;
  let passwordA: string;
  let passwordB: string;
  let hashA: string;
  let hashB: string;

  function tenant(id: string): Tenant {
    return {
      id, cnpj: id === 'tenant-a' ? '12ABC34501DE90' : '98XYZ76501JK10',
      razao_social: `Synthetic ${id}`, status: 'ATIVO', ambiente: 'teste',
      role: 'TRANSPORTADOR', client_id: `synthetic-${id}`, client_secret_hash: 'unused',
      token_duration_hours: 1, conta_ativada: true, created_at: '2026-01-01T00:00:00Z'
    };
  }

  function user(id: string, tenantId: string, passwordHash: string): TenantUser {
    return {
      id, tenant_id: tenantId, nome: id, email, password_hash: passwordHash,
      is_admin_da_conta: true, status: 'ATIVO', created_at: '2026-01-01T00:00:00Z'
    };
  }

  async function post(path: string, body: unknown, bearer?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as any };
  }

  function decodedCompanies(body: any): any[] {
    return body.empresas.map((company: any) => jwt.verify(company.access_token, getJwtSecret()));
  }

  beforeAll(async () => {
    passwordA = crypto.randomBytes(24).toString('base64url');
    passwordB = crypto.randomBytes(24).toString('base64url');
    [hashA, hashB] = await Promise.all([bcrypt.hash(passwordA, 4), bcrypt.hash(passwordB, 4)]);
    const app = express();
    app.use(express.json());
    app.use('/auth', portalIdentityRoutes);
    app.use('/auth', authRoutes);
    app.use('/tenant', tenantIdentityRoutes);
    app.use('/tenant', tenantRoutes);
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    email = `${crypto.randomUUID()}@example.invalid`;
    dbStore.tenants = [tenant('tenant-a'), tenant('tenant-b')];
    dbStore.tenantUsers = [user('user-a', 'tenant-a', hashA), user('user-b', 'tenant-b', hashB)];
    jest.clearAllMocks();
  });

  it.each(['A', 'B'])('emits only the independently authenticated company using password %s', async selected => {
    const result = await post('/auth/portal-login', { email: ` ${email.toUpperCase()} `, senha: selected === 'A' ? passwordA : passwordB });
    expect(result.status).toBe(200);
    const tenantId = selected === 'A' ? 'tenant-a' : 'tenant-b';
    expect(result.body.empresas.map((company: any) => company.tenant_id)).toEqual([tenantId]);
    expect(decodedCompanies(result.body)).toEqual([expect.objectContaining({ tenant_id: tenantId, tenant_user_id: selected === 'A' ? 'user-a' : 'user-b' })]);
    expect(result.body.usuario.nome).toBe(selected === 'A' ? 'user-a' : 'user-b');
    expect(dbStore.persist).not.toHaveBeenCalled();
  });

  it('does not grant another company access from a tenant-local provisioned credential', async () => {
    dbStore.tenantUsers = [user('admin-a', 'tenant-a', hashA), user('user-b', 'tenant-b', hashB)];
    dbStore.tenantUsers[0].email = 'admin-a@example.invalid';
    const bearer = jwt.sign({ tenant_id: 'tenant-a', tenant_user_id: 'admin-a', is_admin_da_conta: true, role: 'TRANSPORTADOR' }, getJwtSecret());
    const created = await post('/tenant/users', { nome: 'Synthetic local user', email, is_admin_da_conta: true }, bearer);
    expect(created.status).toBe(200);
    expect(created.body.user.tenant_id).toBe('tenant-a');
    const result = await post('/auth/portal-login', { email, senha: created.body.senha_temporaria });
    expect(result.status).toBe(200);
    expect(result.body.empresas.map((company: any) => company.tenant_id)).toEqual(['tenant-a']);
    expect(decodedCompanies(result.body)).toEqual([expect.objectContaining({ tenant_id: 'tenant-a', tenant_user_id: created.body.user.id })]);
    expect(dbStore.tenantUsers.find(item => item.id === 'user-b')!.password_hash).toBe(hashB);
  });

  it('preserves multi-company login when each salted credential is verified', async () => {
    const separatelySalted = await bcrypt.hash(passwordA, 4);
    expect(separatelySalted).not.toBe(hashA);
    dbStore.tenantUsers[1].password_hash = separatelySalted;
    dbStore.tenantUsers[1].is_admin_da_conta = false;
    const result = await post('/auth/portal-login', { email, senha: passwordA });
    expect(result.status).toBe(200);
    expect(decodedCompanies(result.body)).toEqual([
      expect.objectContaining({ tenant_id: 'tenant-a', tenant_user_id: 'user-a', is_admin_da_conta: true }),
      expect.objectContaining({ tenant_id: 'tenant-b', tenant_user_id: 'user-b', is_admin_da_conta: false })
    ]);
    expect(result.body.empresas[1].cnpj).toBe('98XYZ76501JK10');
  });

  it.each(['INATIVO', 'different-email'])('does not grant a %s membership with matching password', async state => {
    dbStore.tenantUsers[1].password_hash = hashA;
    if (state === 'INATIVO') dbStore.tenantUsers[1].status = 'INATIVO';
    else dbStore.tenantUsers[1].email = 'other@example.invalid';
    const result = await post('/auth/portal-login', { email, senha: passwordA });
    expect(result.status).toBe(200);
    expect(result.body.empresas.map((company: any) => company.tenant_id)).toEqual(['tenant-a']);
  });

  it.each(['unknown-email', 'wrong-password', 'inactive-match'])('returns generic 401 without tokens for %s', async scenario => {
    if (scenario === 'inactive-match') dbStore.tenantUsers[0].status = 'INATIVO';
    const result = await post('/auth/portal-login', {
      email: scenario === 'unknown-email' ? 'unknown@example.invalid' : email,
      senha: scenario === 'wrong-password' ? crypto.randomUUID() : passwordA
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ codigo: 'ERR-4001', mensagem: 'E-mail ou senha inválidos.' });
    expect(result.body).not.toHaveProperty('empresas');
  });

  it('does not expose an unverified company when the verified membership has no tenant', async () => {
    dbStore.tenants = [tenant('tenant-b')];
    const result = await post('/auth/portal-login', { email, senha: passwordA });
    expect(result.status).toBe(404);
    expect(result.body).not.toHaveProperty('empresas');
  });

  it('keeps invite acceptance scoped to its verified target membership', async () => {
    dbStore.tenantUsers[0].status = 'INATIVO';
    const invite = PortalIdentityService.createUserInvite(dbStore.tenantUsers[0]);
    const selectedPassword = crypto.randomBytes(24).toString('base64url');
    expect((await post(`/auth/portal-password/reset/${invite.token}`, { senha: selectedPassword })).status).toBe(200);
    expect(dbStore.tenantUsers[0].status).toBe('ATIVO');
    expect(dbStore.tenantUsers[1].password_hash).toBe(hashB);
    const result = await post('/auth/portal-login', { email, senha: selectedPassword });
    expect(result.status).toBe(200);
    expect(result.body.empresas.map((company: any) => company.tenant_id)).toEqual(['tenant-a']);
    expect((await post(`/auth/portal-password/reset/${invite.token}`, { senha: selectedPassword })).status).toBe(400);
  });

  it('preserves multi-company access after a verified mailbox reset and revokes old sessions', async () => {
    // Supplying an email alone does not prove ownership; only consuming its delivered token does.
    const reset = PortalIdentityService.createPasswordReset(email)!;
    expect(dbStore.tenantUsers.map(item => item.password_hash)).toEqual([hashA, hashB]);
    const selectedPassword = crypto.randomBytes(24).toString('base64url');
    expect((await post(`/auth/portal-password/reset/${reset.token}`, { senha: selectedPassword })).status).toBe(200);
    const result = await post('/auth/portal-login', { email, senha: selectedPassword });
    expect(result.status).toBe(200);
    expect(decodedCompanies(result.body).map(item => item.tenant_id)).toEqual(['tenant-a', 'tenant-b']);
    const oldIssuedAt = Math.floor(Date.now() / 1000) - 60;
    expect(PortalIdentityService.isPortalSessionStale('user-a', oldIssuedAt)).toBe(true);
    expect(PortalIdentityService.isPortalSessionStale('user-b', oldIssuedAt)).toBe(true);
    expect((await post('/auth/portal-login', { email, senha: passwordA })).status).toBe(401);
    expect((await post(`/auth/portal-password/reset/${reset.token}`, { senha: selectedPassword })).status).toBe(400);
  });
});
