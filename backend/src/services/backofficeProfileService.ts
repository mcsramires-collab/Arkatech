import { v4 as uuidv4 } from 'uuid';
import { Broker, Insurer, RbacProfile, Tenant } from '../types';
import { dbStore } from './dbStore';

type OwnerContext =
  | { owner_type: 'SEGURADORA'; owner: Insurer }
  | { owner_type: 'CORRETORA'; owner: Broker };

function ownerForTenant(tenant: Tenant): OwnerContext | undefined {
  if (tenant.role === 'SEGURADORA') {
    const owner = dbStore.insurers.find((item) => item.tenant_id === tenant.id);
    return owner ? { owner_type: 'SEGURADORA', owner } : undefined;
  }

  if (tenant.role === 'CORRETORA') {
    const owner = dbStore.brokers.find((item) => item.tenant_id === tenant.id);
    return owner ? { owner_type: 'CORRETORA', owner } : undefined;
  }

  return undefined;
}

export function ensureDefaultBackofficeProfile(tenant: Tenant): RbacProfile | undefined {
  const context = ownerForTenant(tenant);
  if (!context) return undefined;

  const existing = dbStore.rbacProfiles.find(
    (profile) =>
      profile.owner_type === context.owner_type &&
      profile.owner_id === context.owner.id
  );
  if (existing) return existing;

  const isInsurer = context.owner_type === 'SEGURADORA';
  const profile: RbacProfile = {
    id: uuidv4(),
    owner_type: context.owner_type,
    owner_id: context.owner.id,
    nome_perfil: isInsurer
      ? 'Administrador da Seguradora'
      : 'Administrador da Corretora',
    permissions: isInsurer
      ? {
          apolices: 'editar',
          clientes: 'editar',
          coberturas: 'editar',
          relatorios: 'ver',
          usuarios: 'editar',
          delegacao_corretora: 'editar'
        }
      : {
          // O RBAC permite executar a ação no Portal; a autonomia real continua sendo decidida
          // pela matriz de delegação e pelas exceções por segurado em /broker/*.
          apolices: 'editar',
          clientes: 'editar',
          coberturas: 'editar',
          relatorios: 'ver',
          usuarios: 'editar',
          delegacao_corretora: 'sem_acesso'
        },
    created_at: new Date().toISOString()
  };

  dbStore.rbacProfiles.push(profile);
  dbStore.persist();
  return profile;
}
