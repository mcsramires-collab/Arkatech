import { dbStore } from './dbStore';

/**
 * Gate de "conta ativada" (aceite do Termo de Uso) — extraído de routes/tenant.ts pra ser
 * reaproveitado também em routes/averbacao.ts (POST /api/v1/averbar). Antes, esse código só era
 * checado nas rotas de /tenant/*; o próprio endpoint de averbação (a ação mais sensível do
 * sistema) não checava — alguém com um JWT válido mas que nunca aceitou o Termo de Uso ainda
 * conseguia averbar normalmente. Ver claude/Mapeamento_Portais_e_Personas.md (Ponto 4) no Project.
 */
export interface ActivationGate {
  ok: boolean;
  code?: number;
  body?: { status: 'erro'; mensagem?: string; codigo?: string };
}

export function checkActivated(tenantId: string): ActivationGate {
  const tenant = dbStore.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return { ok: false, code: 404, body: { status: 'erro', mensagem: 'Cliente não encontrado.' } };
  }
  if (!tenant.conta_ativada) {
    return {
      ok: false,
      code: 403,
      body: {
        status: 'erro',
        codigo: 'ERR-4009',
        mensagem: 'Conta ainda não ativada. Aceite o Termo de Uso para acessar o portal.'
      }
    };
  }
  return { ok: true };
}
