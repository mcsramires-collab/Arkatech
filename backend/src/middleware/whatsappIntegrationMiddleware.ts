import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Segredo exclusivo do adapter de WhatsApp.
 * Não reutiliza INTERNAL_API_KEY: um provedor/adaptador de mensageria não deve ganhar acesso
 * às rotas administrativas da Arckatech.
 */
export function whatsappIntegrationMiddleware(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.WHATSAPP_INTEGRATION_KEY;
  if (!configured) {
    return res.status(503).json({
      status: 'erro',
      codigo: 'WHATSAPP_INTEGRATION_NOT_CONFIGURED',
      mensagem: 'Integração de WhatsApp ainda não configurada neste ambiente.'
    });
  }

  const informed = String(req.header('x-whatsapp-integration-key') || '');
  if (!informed || !safeEqual(informed, configured)) {
    return res.status(401).json({
      status: 'erro',
      codigo: 'WHATSAPP_INTEGRATION_UNAUTHORIZED',
      mensagem: 'Credencial da integração de WhatsApp inválida.'
    });
  }

  next();
}
