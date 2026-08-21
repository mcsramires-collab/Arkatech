/**
 * Integração com a Resend (https://resend.com) para o e-mail de convite de ativação de conta
 * (Fase C do plano — ver claude/Mapeamento_Portais_e_Personas.md, Ponto 2, no Project).
 *
 * A chave de API (RESEND_API_KEY) é configurada pelo próprio usuário direto no Easypanel — este
 * arquivo só lê `process.env.RESEND_API_KEY`, nunca recebe nem grava a chave em nenhum outro lugar.
 * Sem essa variável configurada, o envio é pulado (com um aviso no log) em vez de falhar a
 * requisição inteira — assim o resto do fluxo de cadastro (criar tenant/apólice) continua
 * funcionando normalmente em ambientes de desenvolvimento/teste sem Resend configurado.
 *
 * Usa a API REST da Resend diretamente via `fetch` (disponível globalmente desde o Node 18,
 * e o Dockerfile de produção já usa Node 20) em vez do pacote `resend` — evita adicionar uma
 * dependência nova só para um único POST simples.
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface ActivationEmailParams {
  to: string;
  nomeDestinatario: string;
  razaoSocial: string;
  activationUrl: string;
}

export interface SendEmailResult {
  enviado: boolean;
  motivo?: string;
}

function buildActivationEmailHtml(params: ActivationEmailParams): string {
  const primeiroNome = (params.nomeDestinatario || '').trim().split(/\s+/)[0] || params.nomeDestinatario;
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <p style="margin:0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">Arckatech</p>
                <h1 style="margin:8px 0 0 0;font-size:20px;color:#111827;">Você foi convidado para o Portal do Segurado</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;">
                <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#374151;">Olá, ${primeiroNome},</p>
                <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#374151;">
                  A empresa <strong>${params.razaoSocial}</strong> foi cadastrada no Portal do Segurado Arckatech.
                  Para acessar, defina sua senha e aceite o Termo de Uso clicando no botão abaixo.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 24px 32px;" align="center">
                <a href="${params.activationUrl}" style="display:inline-block;background-color:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">
                  Definir senha e ativar minha conta
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
                  Se o botão não funcionar, copie e cole este link no navegador:<br />
                  <span style="word-break:break-all;">${params.activationUrl}</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Envia o e-mail de convite de ativação. Nunca lança — falhas (chave ausente, erro de rede,
 * resposta não-2xx da Resend) são logadas e devolvidas em `motivo`, para quem chamar decidir o
 * que mostrar ao usuário (ex: "cadastro criado, mas não foi possível enviar o e-mail").
 */
export async function sendActivationInviteEmail(params: ActivationEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'convites@arckatech.com.br';

  if (!apiKey) {
    console.warn(
      `[emailService] RESEND_API_KEY não configurada — e-mail de convite para ${params.to} NÃO enviado (só logado). Configure a variável de ambiente no Easypanel para habilitar o envio real.`
    );
    return { enviado: false, motivo: 'RESEND_API_KEY não configurada no ambiente do servidor.' };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [params.to],
        subject: `Convite: acesso ao Portal do Segurado — ${params.razaoSocial}`,
        html: buildActivationEmailHtml(params)
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[emailService] Falha ao enviar e-mail via Resend (status ${response.status}) para ${params.to}: ${errBody}`);
      return { enviado: false, motivo: `A Resend recusou o envio (HTTP ${response.status}).` };
    }

    return { enviado: true };
  } catch (err: any) {
    console.error(`[emailService] Erro de rede ao chamar a API da Resend (destinatário ${params.to}):`, err);
    return { enviado: false, motivo: 'Erro de rede ao tentar enviar o e-mail.' };
  }
}
