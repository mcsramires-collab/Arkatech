import React from 'react';
import { AlertTriangle } from 'lucide-react';

export function PendingActivationNotice({ termoVersao }: { termoVersao?: string }) {
  return (
    <div style={{ padding: '16px', border: '1px solid var(--accent-amber, #d9a441)', borderRadius: 'var(--radius-sm)', marginBottom: '20px' }}>
      <p style={{ marginBottom: '12px' }}>
        <AlertTriangle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
        Sua conta ainda não foi ativada{termoVersao ? ` (Termo de Uso: ${termoVersao})` : ''}.
        {' '}Para definir sua senha e aceitar o termo, abra o link de convite recebido por e-mail.
      </p>
      <p>Se o convite expirou ou não chegou, solicite o reenvio à sua seguradora ou corretora.</p>
    </div>
  );
}
