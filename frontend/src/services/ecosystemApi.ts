const API_BASE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL || 'http://localhost:3000')
  : '';

export type EcosystemEntityType = 'SEGURADORA' | 'CORRETORA' | 'ASSESSORIA' | 'AMBOS';
export type EcosystemKind = 'insurer' | 'broker';

export interface EcosystemPartner {
  id: string;
  kind: EcosystemKind;
  entity_type: EcosystemEntityType;
  tenant_id?: string;
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string;
  status: 'ATIVO' | 'INATIVO';
  admin_nome?: string;
  admin_email?: string;
  policies_count: number;
  created_at: string;
  capabilities: {
    pode_liderar_apolice: boolean;
    pode_atuar_como_cocorretora: boolean;
    pode_atuar_como_assessoria: boolean;
  };
}

export interface EcosystemPartnerCreatePayload {
  entity_type: EcosystemEntityType;
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string;
  admin_nome?: string;
  admin_email?: string;
}

async function request(endpoint: string, options: RequestInit = {}) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({
    status: 'erro',
    mensagem: `Resposta inválida do backend (${response.status}).`
  }));

  if (!response.ok && !data.status) data.status = 'erro';
  return data;
}

export class EcosystemApi {
  static list() {
    return request('/api/v1/internal/ecosystem-partners');
  }

  static create(payload: EcosystemPartnerCreatePayload) {
    return request('/api/v1/internal/ecosystem-partners', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static update(kind: EcosystemKind, id: string, updates: Partial<{
    razao_social: string;
    nome_fantasia: string;
    entity_type: Exclude<EcosystemEntityType, 'SEGURADORA'>;
    status: 'ATIVO' | 'INATIVO';
  }>) {
    return request(`/api/v1/internal/ecosystem-partners/${kind}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  static resendInvitation(kind: EcosystemKind, id: string, payload?: { admin_nome?: string; admin_email?: string }) {
    return request(`/api/v1/internal/ecosystem-partners/${kind}/${id}/reenviar-convite`, {
      method: 'POST',
      body: JSON.stringify(payload || {})
    });
  }
}
