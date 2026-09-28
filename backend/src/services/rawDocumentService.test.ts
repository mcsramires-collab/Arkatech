import { dbStore } from './dbStore';
import { RawDocumentService } from './rawDocumentService';

describe('RawDocumentService', () => {
  beforeEach(() => {
    dbStore.rawXmlStore = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.rawXmlStore = [];
    jest.restoreAllMocks();
  });

  it('reutiliza o mesmo XML somente dentro do mesmo tenant', () => {
    const first = RawDocumentService.store('<CTe />', 'tenant-1');
    const sameTenant = RawDocumentService.store('<CTe />', 'tenant-1');
    const otherTenant = RawDocumentService.store('<CTe />', 'tenant-2');

    expect(sameTenant.id).toBe(first.id);
    expect(otherTenant.id).not.toBe(first.id);
    expect(dbStore.rawXmlStore).toHaveLength(2);
    expect(dbStore.rawXmlStore.map((item) => item.tenant_id).sort()).toEqual([
      'tenant-1',
      'tenant-2'
    ]);
  });
});
