import { v4 as uuidv4 } from 'uuid';
import { Tenant } from '../types';
import { dbStore } from './dbStore';
import { sendBackofficeActivationInviteEmail, SendEmailResult } from './emailService';

export async function createBackofficeInvitation(
  tenant: Tenant,
  nome: string | undefined,
  email: string | undefined
): Promise<(SendEmailResult & { destino?: string; token?: string }) | undefined> {
  const destino = String(email || '').trim().toLowerCase();
  if (!destino) return undefined;

  // Invalida convites anteriores ainda pendentes deste e-mail/tenant para evitar múltiplos links válidos.
  for (const item of dbStore.activationTokens) {
    if (
      item.tenant_id === tenant.id &&
      !item.aceite &&
      String(item.convite_email || '').trim().toLowerCase() === destino
    ) {
      item.aceite = true;
      item.aceite_em = new Date().toISOString();
    }
  }

  const activation = {
    id: uuidv4(),
    tenant_id: tenant.id,
    token: `backoffice_${uuidv4()}`,
    termo_versao: 'v1',
    aceite: false,
    expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    convite_nome: nome,
    convite_email: destino
  };
  dbStore.activationTokens.push(activation);
  tenant.conta_ativada = false;
  dbStore.persist();

  const baseUrl =
    process.env.BACKOFFICE_APP_URL ||
    process.env.INSURER_PORTAL_URL ||
    'http://localhost:3000';
  const activationUrl = `${baseUrl.replace(/\/$/, '')}/ativacao/${activation.token}`;

  const sent = await sendBackofficeActivationInviteEmail({
    to: destino,
    nomeDestinatario: nome || tenant.razao_social,
    razaoSocial: tenant.razao_social,
    activationUrl,
    perfil: tenant.role === 'SEGURADORA' ? 'Seguradora' : 'Corretora/Assessoria'
  });

  return { ...sent, destino, token: activation.token };
}
