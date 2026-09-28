import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import {
  Connector,
  ConnectorCertificateStatus,
  ConnectorSefazStatus
} from '../types';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export class ConnectorService {
  static register(params: {
    tenant_id: string;
    device_id: string;
    device_name: string;
    version: string;
    os: string;
    capabilities?: string[];
  }): { connector: Connector; device_token: string } {
    const existing = dbStore.connectors.find(
      (connector) =>
        connector.tenant_id === params.tenant_id &&
        connector.device_id === params.device_id &&
        connector.status === 'ATIVO'
    );

    if (existing) {
      throw new Error('CONNECTOR_ALREADY_EXISTS');
    }

    const deviceToken = crypto.randomBytes(32).toString('hex');
    const connector: Connector = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      device_id: params.device_id,
      device_name: params.device_name,
      version: params.version,
      os: params.os,
      capabilities: params.capabilities ?? [],
      status: 'ATIVO',
      device_token_hash: sha256(deviceToken),
      sefaz_status: 'UNKNOWN',
      certificate_status: 'NAO_CONFIGURADO',
      created_at: new Date().toISOString()
    };

    dbStore.connectors.unshift(connector);
    dbStore.persist();

    return { connector, device_token: deviceToken };
  }

  static authenticate(deviceToken: string | undefined): Connector | null {
    if (!deviceToken) return null;
    const hash = sha256(deviceToken);
    return (
      dbStore.connectors.find(
        (connector) => connector.status === 'ATIVO' && connector.device_token_hash === hash
      ) ?? null
    );
  }

  static revoke(tenantId: string, connectorId: string): Connector | null {
    const connector = dbStore.connectors.find(
      (item) => item.id === connectorId && item.tenant_id === tenantId
    );
    if (!connector) return null;
    connector.status = 'REVOGADO';
    connector.revoked_at = new Date().toISOString();
    dbStore.persist();
    return connector;
  }

  static heartbeat(
    connector: Connector,
    params: {
      version?: string;
      sefaz_status?: ConnectorSefazStatus;
      last_sync_at?: string;
    }
  ): Connector {
    if (params.version) connector.version = params.version;
    if (params.sefaz_status) connector.sefaz_status = params.sefaz_status;
    if (params.last_sync_at) connector.last_sync_at = params.last_sync_at;
    connector.last_heartbeat_at = new Date().toISOString();
    dbStore.persist();
    return connector;
  }

  static updateCertificateStatus(
    connector: Connector,
    params: {
      status: ConnectorCertificateStatus;
      cnpj?: string;
      type?: 'A1' | 'A3';
      issuer?: string;
      serial_number_hash?: string;
      valid_from?: string;
      valid_until?: string;
    }
  ): Connector {
    connector.certificate_status = params.status;
    connector.certificate_cnpj = params.cnpj;
    connector.certificate_type = params.type;
    connector.certificate_issuer = params.issuer;
    connector.certificate_serial_hash = params.serial_number_hash;
    connector.certificate_valid_from = params.valid_from;
    connector.certificate_valid_until = params.valid_until;
    dbStore.persist();
    return connector;
  }

  static publicView(connector: Connector) {
    const { device_token_hash, ...safe } = connector;
    return safe;
  }
}
