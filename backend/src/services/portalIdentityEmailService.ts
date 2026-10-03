const RESEND_API_URL = 'https://api.resend.com/emails';

export interface PortalIdentityEmailResult {
  enviado: boolean;
  motivo?: string;
}

function portalBaseUrl(): string {
  return (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function send(params: {
  to: string;
  subject: string;
  title: string;
  intro: string;
  button: string;
  url: string;
  expiresText: string;
}): Promise<PortalIdentityEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'convites@arckatech.com.br';
  if (!apiKey) {
    console.warn(`[portalIdentityEmail] RESEND_API_KEY ausente — envio para ${params.to} ignorado.`);
    return { enviado: false, motivo: 'RESEND_API_KEY não configurada no ambiente do servidor.' };
  }

  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;background:#f4f5f7">
      <tr><td align="center">
        <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px">
          <tr><td style="padding:32px">
            <p style="margin:0 0 8px;color:#6b7280;font-size:13px;letter-spacing:.04em;text-transform:uppercase">Arckatech</p>
            <h1 style="margin:0 0 20px;color:#111827;font-size:20px">${escapeHtml(params.title)}</h1>
            <p style="color:#374151;font-size:14px;line-height:1.6">${escapeHtml(params.intro)}</p>
            <p style="margin:24px 0;text-align:center">
              <a href="${escapeHtml(params.url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(params.button)}</a>
            </p>
            <p style="font-size:12px;color:#6b7280;line-height:1.6">${escapeHtml(params.expiresText)}</p>
            <p style="font-size:12px;color:#9ca3af;line-height:1.6">Se o botão não funcionar, copie e cole este link:<br><span style="word-break:break-all">${escapeHtml(params.url)}</span></p>
            <p style="font-size:12px;color:#9ca3af;line-height:1.6">Se você não solicitou esta ação, ignore este e-mail. O link só pode ser usado uma vez.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: fromEmail, to: [params.to], subject: params.subject, html })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[portalIdentityEmail] Resend HTTP ${response.status}: ${body}`);
      return { enviado: false, motivo: `A Resend recusou o envio (HTTP ${response.status}).` };
    }
    return { enviado: true };
  } catch (error) {
    console.error('[portalIdentityEmail] Falha de rede no envio.', error);
    return { enviado: false, motivo: 'Erro de rede ao tentar enviar o e-mail.' };
  }
}

export function sendPortalPasswordResetEmail(params: { to: string; token: string }) {
  const url = `${portalBaseUrl()}/reset-password/${encodeURIComponent(params.token)}`;
  return send({
    to: params.to,
    subject: 'Redefinição de senha — Portal do Segurado Arckatech',
    title: 'Redefina sua senha',
    intro: 'Recebemos uma solicitação para redefinir a senha do seu acesso ao Portal do Segurado.',
    button: 'Criar nova senha',
    url,
    expiresText: 'Este link expira em 1 hora.'
  });
}

export function sendPortalUserInviteEmail(params: {
  to: string;
  token: string;
  nome: string;
  razaoSocial: string;
}) {
  const url = `${portalBaseUrl()}/reset-password/${encodeURIComponent(params.token)}`;
  return send({
    to: params.to,
    subject: `Convite de acesso — ${params.razaoSocial}`,
    title: 'Ative seu acesso ao Portal do Segurado',
    intro: `${params.nome}, você recebeu acesso à empresa ${params.razaoSocial}. Defina sua senha para concluir a ativação.`,
    button: 'Definir senha',
    url,
    expiresText: 'Este convite expira em 7 dias.'
  });
}
