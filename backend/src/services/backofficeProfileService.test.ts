import { dbStore } from './dbStore';
import { ensureDefaultBackofficeProfile } from './backofficeProfileService';

describe('ensureDefaultBackofficeProfile', () => {
  beforeEach(() => {
    dbStore.rbacProfiles = [];
    dbStore.insurers = [];
    dbStore.brokers = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.rbacProfiles = [];
    dbStore.insurers = [];
    dbStore.brokers = [];
    jest.restoreAllMocks();
  });

  it('cria perfil administrador para corretora vinculada ao tenant', () => {
    dbStore.brokers = [{
      id: 'broker-1',
      tenant_id: 'tenant-broker',
      cnpj: '12ABC34501DE35',
      nome: 'Parceiro',
      partner_type: 'ASSESSORIA',
      created_at: new Date().toISOString()
    }] as any;

    const tenant = {
      id: 'tenant-broker',
      cnpj: '12ABC34501DE35',
      razao_social: 'Parceiro',
      status: 'ATIVO',
      ambiente: 'producao',
      client_id: 'client',
      client_secret_hash: 'hash',
      role: 'CORRETORA',
      token_duration_hours: 8,
      created_at: new Date().toISOString()
    } as any;

    const profile = ensureDefaultBackofficeProfile(tenant);

    expect(profile).toMatchObject({
      owner_type: 'CORRETORA',
      owner_id: 'broker-1',
      nome_perfil: 'Administrador da Corretora'
    });
    expect(profile?.permissions).toMatchObject({
      clientes: 'editar',
      apolices: 'editar',
      coberturas: 'editar',
      relatorios: 'ver',
      delegacao_corretora: 'sem_acesso'
    });
  });

  it('reutiliza perfil existente do proprietário', () => {
    dbStore.brokers = [{
      id: 'broker-1',
      tenant_id: 'tenant-broker',
      cnpj: '12345678000195',
      nome: 'Corretora',
      created_at: new Date().toISOString()
    }] as any;
    dbStore.rbacProfiles = [{
      id: 'profile-existing',
      owner_type: 'CORRETORA',
      owner_id: 'broker-1',
      nome_perfil: 'Perfil existente',
      permissions: {
        apolices: 'ver',
        clientes: 'ver',
        coberturas: 'ver',
        relatorios: 'ver',
        usuarios: 'sem_acesso',
        delegacao_corretora: 'sem_acesso'
      },
      created_at: new Date().toISOString()
    }] as any;

    const tenant = {
      id: 'tenant-broker',
      role: 'CORRETORA'
    } as any;

    expect(ensureDefaultBackofficeProfile(tenant)?.id).toBe('profile-existing');
    expect(dbStore.rbacProfiles).toHaveLength(1);
  });
});
