import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditService } from './auditService';

describe('AuditService', () => {
  test('persiste eventos append-only e filtra por seguradora/tenant/ação', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arckatech-audit-'));
    const file = path.join(dir, 'audit.json');
    try {
      const service = new AuditService(file);
      service.record({
        actor_type: 'SEGURADORA',
        actor_id: 'user-a',
        actor_name: 'User A',
        insurer_id: 'insurer-a',
        tenant_id: 'tenant-a',
        module: 'clientes',
        entity_type: 'TENANT',
        entity_id: 'tenant-a',
        action: 'UPDATE',
        before: { nome: 'A' },
        after: { nome: 'B' }
      });
      service.record({
        actor_type: 'SEGURADORA',
        actor_id: 'user-b',
        insurer_id: 'insurer-b',
        tenant_id: 'tenant-b',
        module: 'clientes',
        entity_type: 'TENANT',
        entity_id: 'tenant-b',
        action: 'STATUS_CHANGE'
      });

      expect(service.list({ insurer_id: 'insurer-a' })).toHaveLength(1);
      expect(service.list({ tenant_id: 'tenant-b', action: 'STATUS_CHANGE' })[0]).toMatchObject({
        insurer_id: 'insurer-b',
        entity_id: 'tenant-b'
      });

      const reloaded = new AuditService(file);
      expect(reloaded.list()).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
