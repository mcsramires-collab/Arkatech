import bcrypt from 'bcryptjs';
import { dbStore } from './dbStore';
import { PortalIdentityService } from './portalIdentityService';
import { TenantUser } from '../types';

describe('PortalIdentityService', () => {
  const originalUsers = [...dbStore.tenantUsers];

  afterEach(() => {
    dbStore.tenantUsers = [...originalUsers];
  });

  it('stores only token hash, resets password once and invalidates older personal sessions', async () => {
    const tenant = dbStore.tenants.find((item) => item.role === 'TRANSPORTADOR');
    expect(tenant).toBeDefined();
    const email = `reset-${Date.now()}@example.com`;
    const user: TenantUser = {
      id: `usr-reset-${Date.now()}`,
      tenant_id: tenant!.id,
      nome: 'Usuário Reset',
      email,
      password_hash: await bcrypt.hash('SenhaAntiga123', 10),
      is_admin_da_conta: true,
      status: 'ATIVO',
      created_at: new Date().toISOString()
    };
    dbStore.tenantUsers.push(user);

    const created = PortalIdentityService.createPasswordReset(email);
    expect(created).toBeDefined();
    expect(created!.token.length).toBeGreaterThan(30);
    const stored = PortalIdentityService._debugRecords().find(
      (record) => record.target_user_ids.includes(user.id) && !record.used_at
    );
    expect(stored).toBeDefined();
    expect(stored!.token_hash).not.toBe(created!.token);
    expect(JSON.stringify(stored)).not.toContain(created!.token);

    const issuedBeforeReset = Math.floor(Date.now() / 1000) - 60;
    const result = await PortalIdentityService.consume(created!.token, 'SenhaNova123');
    expect(result.purpose).toBe('PASSWORD_RESET');
    expect(await bcrypt.compare('SenhaNova123', user.password_hash)).toBe(true);
    expect(PortalIdentityService.inspect(created!.token)).toBeNull();
    expect(PortalIdentityService.isPortalSessionStale(user.id, issuedBeforeReset)).toBe(true);

    await expect(
      PortalIdentityService.consume(created!.token, 'OutraSenha123')
    ).rejects.toThrow('PORTAL_ACCESS_TOKEN_INVALID');
  });

  it('activates an invited user only after the one-time link is consumed', async () => {
    const tenant = dbStore.tenants.find((item) => item.role === 'TRANSPORTADOR');
    expect(tenant).toBeDefined();
    const user: TenantUser = {
      id: `usr-invite-${Date.now()}`,
      tenant_id: tenant!.id,
      nome: 'Usuário Convidado',
      email: `invite-${Date.now()}@example.com`,
      password_hash: await bcrypt.hash('NuncaCompartilhada123', 10),
      is_admin_da_conta: false,
      status: 'INATIVO',
      created_at: new Date().toISOString()
    };
    dbStore.tenantUsers.push(user);

    const invite = PortalIdentityService.createUserInvite(user);
    expect(PortalIdentityService.inspect(invite.token)?.purpose).toBe('USER_INVITE');
    expect(user.status).toBe('INATIVO');

    const results = await Promise.allSettled([
      PortalIdentityService.consume(invite.token, 'MinhaSenha123'),
      PortalIdentityService.consume(invite.token, 'MinhaSenha123')
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(user.status).toBe('ATIVO');
    expect(await bcrypt.compare('MinhaSenha123', user.password_hash)).toBe(true);
    expect(PortalIdentityService.inspect(invite.token)).toBeNull();
  });
});
