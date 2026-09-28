import { dbStore } from './dbStore';
import { ConnectorService } from './connectorService';

describe('ConnectorService', () => {
  beforeEach(() => {
    dbStore.connectors = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.connectors = [];
    jest.restoreAllMocks();
  });

  it('registra conector e nunca persiste o token em texto puro', () => {
    const { connector, device_token } = ConnectorService.register({
      tenant_id: 'tenant-1',
      device_id: 'pc-01',
      device_name: 'Financeiro',
      version: '1.0.0',
      os: 'windows',
      capabilities: ['CTE_DFE']
    });

    expect(device_token).toHaveLength(64);
    expect(connector.device_token_hash).toHaveLength(64);
    expect(connector.device_token_hash).not.toBe(device_token);
    expect(ConnectorService.authenticate(device_token)?.id).toBe(connector.id);
  });

  it('impede dois conectores ativos com o mesmo device_id no mesmo tenant', () => {
    ConnectorService.register({
      tenant_id: 'tenant-1',
      device_id: 'pc-01',
      device_name: 'Financeiro',
      version: '1.0.0',
      os: 'windows'
    });

    expect(() =>
      ConnectorService.register({
        tenant_id: 'tenant-1',
        device_id: 'pc-01',
        device_name: 'Financeiro 2',
        version: '1.0.1',
        os: 'windows'
      })
    ).toThrow('CONNECTOR_ALREADY_EXISTS');
  });

  it('revogação invalida imediatamente o device token', () => {
    const { connector, device_token } = ConnectorService.register({
      tenant_id: 'tenant-1',
      device_id: 'pc-01',
      device_name: 'Financeiro',
      version: '1.0.0',
      os: 'windows'
    });

    ConnectorService.revoke('tenant-1', connector.id);

    expect(connector.status).toBe('REVOGADO');
    expect(connector.revoked_at).toBeDefined();
    expect(ConnectorService.authenticate(device_token)).toBeNull();
  });

  it('heartbeat e certificado atualizam apenas metadados operacionais', () => {
    const { connector } = ConnectorService.register({
      tenant_id: 'tenant-1',
      device_id: 'pc-01',
      device_name: 'Financeiro',
      version: '1.0.0',
      os: 'windows'
    });

    ConnectorService.heartbeat(connector, {
      version: '1.0.1',
      sefaz_status: 'ONLINE',
      last_sync_at: '2026-09-28T00:00:00.000Z'
    });

    ConnectorService.updateCertificateStatus(connector, {
      status: 'VALID',
      cnpj: '12345678000190',
      type: 'A1',
      issuer: 'AC Teste',
      serial_number_hash: 'abc123',
      valid_until: '2027-09-28T00:00:00.000Z'
    });

    expect(connector).toMatchObject({
      version: '1.0.1',
      sefaz_status: 'ONLINE',
      certificate_status: 'VALID',
      certificate_cnpj: '12345678000190',
      certificate_type: 'A1',
      certificate_issuer: 'AC Teste',
      certificate_serial_hash: 'abc123'
    });
    expect(connector.last_heartbeat_at).toBeDefined();
  });

  it('publicView remove o hash do token', () => {
    const { connector } = ConnectorService.register({
      tenant_id: 'tenant-1',
      device_id: 'pc-01',
      device_name: 'Financeiro',
      version: '1.0.0',
      os: 'windows'
    });

    const safe = ConnectorService.publicView(connector) as Record<string, unknown>;
    expect(safe.device_token_hash).toBeUndefined();
  });
});
