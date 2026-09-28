import { NextFunction, Request, Response } from 'express';
import { Connector } from '../types';
import { ConnectorService } from '../services/connectorService';

export interface ConnectorAuthenticatedRequest extends Request {
  connector?: Connector;
}

export function connectorAuthMiddleware(
  req: ConnectorAuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const tokenHeader = req.headers['x-connector-token'];
  const token =
    typeof tokenHeader === 'string'
      ? tokenHeader
      : req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice('Bearer '.length)
        : undefined;

  const connector = ConnectorService.authenticate(token);
  if (!connector) {
    return res.status(401).json({
      status: 'erro',
      codigo: 'CONNECTOR_UNAUTHORIZED',
      mensagem: 'Conector não autenticado, revogado ou token inválido.'
    });
  }

  req.connector = connector;
  next();
}
