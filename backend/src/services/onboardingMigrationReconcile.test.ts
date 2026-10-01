import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbStore } from './dbStore';
import { OnboardingMigrationService } from './onboardingMigration';
import { reconcileMigrationOnboardingForInsurer } from './onboardingMigrationReconcile';

function textFile(content: string) {
  return {
    originalname: 'apolice-54-55.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from(content, 'utf8')
  };
}

describe('reconcileMigrationOnboardingForInsurer', () => {
  const original = {
    insurers: dbStore.insurers,
    tenants: dbStore.tenants,
    policies: dbStore.policies,
    additional: dbStore.tenantCnpjsAdicionais
  };
  let root: string;
  let service: OnboardingMigrationService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'arckatech-reconcile-'));
    service = new OnboardingMigrationService(root);
    const now = new Date().toISOString();
    dbStore.insurers = [
      { id: 'origin', cnpj: '11111111000191', nome: 'Origem', created_at: now },
      { id: 'target', cnpj: '22222222000192', nome: 'Destino', created_at: now }
    ];
    dbStore.tenants = [{
      id: 'tenant-migration',
      cnpj: '12345678000190',
      razao_social: 'Transportadora Migração',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client',
      client_secret_hash: 'hash',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: now
    }];
    dbStore.tenantCnpjsAdicionais = [];
    dbStore.policies = [
      {
        id: 'origin-54', numero_apolice: 'O54', ramo: 'RCTRC', tenant_id: 'tenant-migration',
        insurer_id: 'origin', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z', vigencia_fim: '2026-12-31T23:59:59.000Z',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'origin-55', numero_apolice: 'O55', ramo: 'RCDC', tenant_id: 'tenant-migration',
        insurer_id: 'origin', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z', vigencia_fim: '2026-12-31T23:59:59.000Z',
        aceita_averbacao_como_destinatario: false
      }
    ];
  });

  afterEach(() => {
    dbStore.insurers = original.insurers;
    dbStore.tenants = original.tenants;
    dbStore.policies = original.policies;
    dbStore.tenantCnpjsAdicionais = original.additional;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('só conclui quando 54 e 55 possuem destino ativo na seguradora recebedora', async () => {
    const analyzed = await service.analyzeDocument(
      'target',
      textFile(
        'APÓLICE Nº 5455001234\n' +
        'Segurado: Transportadora Migração\n' +
        'CNPJ do Segurado: 12.345.678/0001-90\n' +
        'Ramos: 54 - RCTR-C e 55 - RCDC\n' +
        'LMI: R$ 1.000.000,00\n' +
        'Vigência: 01/01/2026 a 31/12/2026'
      )
    );
    const request = service.createMigrationRequest({
      requesterInsurerId: 'target',
      cnpj: '12345678000190',
      selectedRamos: ['54', '55'],
      documentIds: [analyzed.id],
      termAccepted: true,
      scheduledStart: '2026-10-01'
    });
    expect(request.status).toBe('PROGRAMADA');

    let result = reconcileMigrationOnboardingForInsurer('target', service);
    expect(result.completed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('54');
    expect(service.listRequests('target')[0]?.onboarding_completed).toBe(false);

    dbStore.policies.push({
      id: 'target-54', numero_apolice: 'T54', ramo: 'RCTRC', tenant_id: 'tenant-migration',
      insurer_id: 'target', broker_id: 'b2', status: 'ATIVA', permitir_inativo_vencido: false,
      vigencia_inicio: '2026-10-01T00:00:00.000Z', vigencia_fim: '2027-09-30T23:59:59.000Z',
      aceita_averbacao_como_destinatario: false
    });

    result = reconcileMigrationOnboardingForInsurer('target', service);
    expect(result.completed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('55');
    expect(service.listRequests('target')[0]?.onboarding_completed).toBe(false);

    dbStore.policies.push({
      id: 'target-55', numero_apolice: 'T55', ramo: 'RCDC', tenant_id: 'tenant-migration',
      insurer_id: 'target', broker_id: 'b2', status: 'ATIVA', permitir_inativo_vencido: false,
      vigencia_inicio: '2026-10-01T00:00:00.000Z', vigencia_fim: '2027-09-30T23:59:59.000Z',
      aceita_averbacao_como_destinatario: false
    });

    result = reconcileMigrationOnboardingForInsurer('target', service);
    expect(result.completed).toEqual([request.id]);
    const reconciled = service.listRequests('target')[0]!;
    expect(reconciled.onboarding_completed).toBe(true);
    expect(reconciled.target_policy_ids.sort()).toEqual(['target-54', 'target-55']);

    // Idempotência: depois de concluído, novas mutações não reabrem nem duplicam a migração.
    const again = reconcileMigrationOnboardingForInsurer('target', service);
    expect(again.inspected).toBe(0);
    expect(again.completed).toEqual([]);
  });
});
