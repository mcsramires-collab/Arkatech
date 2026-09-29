import { dbStore } from './dbStore';
import { TestLabCatalogAuditService } from './testLabCatalogAudit';

describe('TestLabCatalogAuditService', () => {
  const original = dbStore.policyBusinessSettings;

  afterEach(() => {
    dbStore.policyBusinessSettings = original;
  });

  test('detecta flag persistida que não foi catalogada', () => {
    dbStore.policyBusinessSettings = [
      {
        id: 'audit-test',
        policy_id: 'p-test',
        config: { 'regras:flag-nova-sem-teste': true },
        updated_at: new Date().toISOString()
      }
    ];

    const audit = TestLabCatalogAuditService.audit();
    expect(audit.uncatalogued_business_keys).toContain('regras:flag-nova-sem-teste');
    expect(audit.ok).toBe(false);
  });
});
