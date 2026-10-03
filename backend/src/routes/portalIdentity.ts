import { Router } from 'express';
import { PortalIdentityService } from '../services/portalIdentityService';
import { sendPortalPasswordResetEmail } from '../services/portalIdentityEmailService';

const router = Router();

const GENERIC_FORGOT_MESSAGE =
  'Se existir uma conta ativa para este e-mail, enviaremos um link de redefinição de senha.';

/**
 * Público e deliberadamente não enumerável: e-mail conhecido, desconhecido, rate-limit silencioso
 * e falha de provedor devolvem o mesmo contrato HTTP.
 */
router.post('/portal-password/forgot', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    // Mesmo status/mensagem para não transformar validação em oráculo de existência da conta.
    return res.status(200).json({ status: 'sucesso', mensagem: GENERIC_FORGOT_MESSAGE });
  }

  const reset = PortalIdentityService.createPasswordReset(email);
  if (reset) {
    const result = await sendPortalPasswordResetEmail({ to: email, token: reset.token });
    if (!result.enviado) {
      console.warn(`[portalIdentity] Reset criado para ${email}, mas e-mail não foi enviado: ${result.motivo}`);
    }
  }

  return res.status(200).json({ status: 'sucesso', mensagem: GENERIC_FORGOT_MESSAGE });
});

/** Consulta pública do token; não revela o e-mail completo. */
router.get('/portal-password/reset/:token', (req, res) => {
  const info = PortalIdentityService.inspect(String(req.params.token || ''));
  if (!info) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Este link é inválido, já foi usado ou expirou.'
    });
  }
  return res.json({ status: 'sucesso', acesso: info });
});

/** Define a nova senha para reset OU convite de usuário usando o mesmo link seguro. */
router.post('/portal-password/reset/:token', async (req, res) => {
  const senha = String(req.body?.senha || '');
  const confirmacao = String(req.body?.confirmacao || '');
  if (senha.length < 8) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'A senha precisa ter ao menos 8 caracteres.'
    });
  }
  if (confirmacao && confirmacao !== senha) {
    return res.status(400).json({ status: 'erro', mensagem: 'A confirmação da senha não confere.' });
  }

  try {
    const result = await PortalIdentityService.consume(String(req.params.token || ''), senha);
    return res.json({
      status: 'sucesso',
      mensagem:
        result.purpose === 'USER_INVITE'
          ? 'Acesso ativado e senha definida. Você já pode fazer login.'
          : 'Senha redefinida com sucesso. Faça login novamente em seus dispositivos.',
      purpose: result.purpose
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'PORTAL_PASSWORD_TOO_SHORT') {
      return res.status(400).json({ status: 'erro', mensagem: 'A senha precisa ter ao menos 8 caracteres.' });
    }
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Este link é inválido, já foi usado ou expirou.'
    });
  }
});

export default router;
