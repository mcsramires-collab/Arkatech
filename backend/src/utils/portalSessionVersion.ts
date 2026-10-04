import crypto from 'crypto';
import { TenantUser } from '../types';
import { getJwtSecret } from './jwtSecret';

/** Versão opaca da credencial, sem expor seu hash nem exigir novos campos persistidos. */
export function getPortalSessionVersion(user: Pick<TenantUser, 'id' | 'tenant_id' | 'password_hash'>): string {
  return crypto.createHmac('sha256', getJwtSecret())
    .update(JSON.stringify(['portal-session-v1', user.tenant_id, user.id, user.password_hash]))
    .digest('hex');
}
