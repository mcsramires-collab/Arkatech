import { dbStore } from './dbStore';
import { FiscalSyncService } from './fiscalSyncService';
import { Connector } from '../types';

describe('FiscalSyncService', () => {
  const connector: Connector = {
    id: 'connector-1',
    tenant_id: 'tenant-1',
    device_id: 'pc-1',
    device_name: 'PC 1',
    version: '1.0.0',
    os: 'windows',
    capabilities: ['NFE_DFE', 'CTE_DFE'],
    status: 'ATIVO',
    device_token_hash: 'hash',
    sefaz_status: 'ONLINE',
    certificate_status: 'VALID',
    created_at: '2026-09-28T00:00:00.000Z'
  };

  beforeEach(() => {
    dbStore.fiscalSyncStates = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.fiscalSyncStates = [];
    jest.restoreAllMocks();
  });

  it('cria e atualiza estado mantendo NSU monotônico', () => {
    const first = FiscalSyncService.report(connector, {
      provider: 'NFE', status: 'OK', ult_nsu: '100', max_nsu: '120', cstat: 138, document_count: 20
    });

    const second = FiscalSyncService.report(connector, {
      provider: 'NFE', status: 'NO_DOCUMENTS', ult_nsu: '120', max_nsu: '120', cstat: 137, document_count: 0
    });

    expect(first.id).toBe(second.id);
    expect(dbStore.fiscalSyncStates).toHaveLength(1);
    expect(second.ult_nsu).toBe('120');
    expect(second.next_sync_after).toBeDefined();
    expect(new Date(second.next_sync_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejeita regressão de ultNSU e maxNSU', () => {
    FiscalSyncService.report(connector, {
      provider: 'CTE', status: 'OK', ult_nsu: '100', max_nsu: '150', cstat: 138
    });

    expect(() => FiscalSyncService.report(connector, {
      provider: 'CTE', status: 'OK', ult_nsu: '99', max_nsu: '150', cstat: 138
    })).toThrow('NSU_REGRESSION');

    expect(() => FiscalSyncService.report(connector, {
      provider: 'CTE', status: 'OK', ult_nsu: '100', max_nsu: '149', cstat: 138
    })).toThrow('MAX_NSU_REGRESSION');
  });

  it('rejeita status incompatível com cStat conhecido', () => {
    expect(() => FiscalSyncService.report(connector, {
      provider: 'NFE', status: 'OK', ult_nsu: '10', max_nsu: '10', cstat: 137
    })).toThrow('SYNC_STATUS_CSTAT_MISMATCH');
  });

  it('devolve estado de retomada com NEVER_SYNCED para providers ainda não consultados', () => {
    FiscalSyncService.report(connector, {
      provider: 'CTE', status: 'OK', ult_nsu: '42', max_nsu: '50', document_count: 8
    });

    const resume = FiscalSyncService.publicResumeState(connector);
    expect(resume.CTE.ult_nsu).toBe('42');
    expect(resume.CTE.status).toBe('OK');
    expect(resume.NFE.status).toBe('NEVER_SYNCED');
    expect(resume.MDFE.status).toBe('NEVER_SYNCED');
  });
});
