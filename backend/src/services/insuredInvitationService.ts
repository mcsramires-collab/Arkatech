import { v4 as uuidv4 } from 'uuid';
import { ActivationToken, Tenant } from '../types';
import { dbStore } from './dbStore';
import { sendActivationInviteEmail } from './emailService';

function portalSeguradoBaseUrl(): string {
  return process.env.PUBLIC_APP_URL || 'http://localhost:5173';
}

export function createInsuredActivationToken(
  tenant: Tenant,
  nomeConvidado?: string,
  emailConvidado?: string
): ActivationToken {
  const now = new Date().toISOString();

  for (const item of dbStore.activationTokens) {
    if (
      item.tenant_id === tenant.id &&
      !item.aceite &&
      (
        !emailConvidado ||
        String(item.convite_email || '').trim().toLowerCase() ===
          String(emailConvidado).trim().toLowerCase()
      )
    ) {
      item.aceite = true;
      item.aceite_em = now;
    }
  }

  const activation: ActivationToken = {
    id: uuidv4(),
    tenant_id: tenant.id,
    token: `act_${uuidv4()}`,
    termo_versao: 'v1',
    aceite: false,
    expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: now,
    convite_nome: nomeConvidado,
    convite_email: emailConvidado
  };

  dbStore.activationTokens.push(activation);
  tenant.conta_ativada = false;
  dbStore.persist();
  return activation;
}

export async function createAndSendInsuredInvitation(
  tenant: Tenant,
  nomeConvidado?: string,
  emailConvidado?: string
): Promise<{ enviado: boolean; destino?: string; motivo?: string; token: string }> {
  const activation = createInsuredActivationToken(tenant, nomeConvidado, emailConvidado);
  const destino = String(emailConvidado || tenant.contato_email || '').trim().toLowerCase();

  if (!destino) {
    return {
      enviado: false,
      motivo: 'Nenhum e-mail de contato informado para este cliente.',
      token: activation.token
    };
  }

  const resultado = await sendActivationInviteEmail({
    to: destino,
    nomeDestinatario: nomeConvidado || tenant.contato_nome || tenant.razao_social,
    razaoSocial: tenant.razao_social,
    activationUrl: `${portalSeguradoBaseUrl().replace(/\/$/, '')}/ativacao/${activation.token}`
  });

  return { ...resultado, destino, token: activation.token };
}
