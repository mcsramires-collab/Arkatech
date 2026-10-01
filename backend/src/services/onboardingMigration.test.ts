import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbStore } from './dbStore';
import { OnboardingMigrationError, OnboardingMigrationService } from './onboardingMigration';

function textFile(name: string, content: string) {
  return {
    originalname: name,
    mimetype: 'text/plain',
    buffer: Buffer.from(content, 'utf8')
  };
}

describe('OnboardingMigrationService', () => {
  let root: string;
  let service: OnboardingMigrationService;
  let persistSpy: jest.SpyInstance;
  const backup = {
    insurers: [] as typeof dbStore.insurers,
    tenants: [] as typeof dbStore.tenants,
    policies: [] as typeof dbStore.policies,
    additional: [] as typeof dbStore.tenantCnpjsAdicionais
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'arckatech-migration-'));
    service = new OnboardingMigrationService(root);
    persistSpy = jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);

    backup.insurers = dbStore.insurers;
    backup.tenants = dbStore.tenants;
    backup.policies = dbStore.policies;
    backup.additional = dbStore.tenantCnpjsAdicionais;

    dbStore.insurers = [
      { id: 'insurer-origin', cnpj: '11111111000191', nome: 'Origem', created_at: new Date().toISOString() },
      { id: 'insurer-target', cnpj: '22222222000192', nome: 'Destino', created_at: new Date().toISOString() }
    ];
    dbStore.tenants = [
      {
        id: 'tenant-1',
        cnpj: '12345678000190',
        razao_social: 'Transportadora Horizonte Ltda',
        status: 'ATIVO',
        ambiente: 'teste',
        client_id: 'tenant-client',
        client_secret_hash: 'hash',
        role: 'TRANSPORTADOR',
        token_duration_hours: 8,
        created_at: new Date().toISOString()
      }
    ];
    dbStore.tenantCnpjsAdicionais = [];
    dbStore.policies = [
      {
        id: 'source-54',
        numero_apolice: 'ORIG-54',
        ramo: 'RCTRC',
        tenant_id: 'tenant-1',
        insurer_id: 'insurer-origin',
        broker_id: 'broker-1',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z',
        vigencia_fim: '2026-12-31T23:59:59.000Z',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'source-55',
        numero_apolice: 'ORIG-55',
        ramo: 'RCDC',
        tenant_id: 'tenant-1',
        insurer_id: 'insurer-origin',
        broker_id: 'broker-1',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01T00:00:00.000Z',
        vigencia_fim: '2026-12-31T23:59:59.000Z',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'target-54',
        numero_apolice: 'DEST-54',
        ramo: 'RCTRC',
        tenant_id: 'tenant-1',
        insurer_id: 'insurer-target',
        broker_id: 'broker-2',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-10-01T00:00:00.000Z',
        vigencia_fim: '2027-09-30T23:59:59.000Z',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'target-55',
        numero_apolice: 'DEST-55',
        ramo: 'RCDC',
        tenant_id: 'tenant-1',
        insurer_id: 'insurer-target',
        broker_id: 'broker-2',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-10-01T00:00:00.000Z',
        vigencia_fim: '2027-09-30T23:59:59.000Z',
        aceita_averbacao_como_destinatario: false
      }
    ];
  });

  afterEach(() => {
    persistSpy.mockRestore();
    dbStore.insurers = backup.insurers;
    dbStore.tenants = backup.tenants;
    dbStore.policies = backup.policies;
    dbStore.tenantCnpjsAdicionais = backup.additional;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('analisa apólice textual, detecta migração e reutiliza o documento como comprovação', async () => {
    const analyzed = await service.analyzeDocument(
      'insurer-target',
      textFile(
        'apolice-54.txt',
        [
          'APÓLICE Nº 5400012345',
          'Segurado: Transportadora Horizonte Ltda',
          'CNPJ do Segurado: 12.345.678/0001-90',
          'Ramo: 54 - RCTR-C',
          'LMI: R$ 1.500.000,00',
          'Vigência: 01/01/2026 a 31/12/2026',
          'Código Interno da Seguradora: SEG-54-001',
          'Corretora Líder: Corretora Exemplo Seguros Ltda',
          'CNPJ da Corretora: 45.678.901/0001-23'
        ].join('\n')
      )
    );

    expect(analyzed.document_type).toBe('APOLICE');
    expect(analyzed.extraction_level).toBe('COMPLETA');
    expect(analyzed.fields.cnpj?.value).toBe('12345678000190');
    expect(analyzed.extracted_ramos).toContain('54');
    expect(analyzed.migration_proof_eligible).toBe(true);
    expect(analyzed.scenario).toBe('MIGRACAO');
    expect(analyzed.migration?.eligible_ramos).toEqual(['54', '55']);
  });

  test('programa migração aprovada e cria somente aviso neutro para a seguradora de origem', async () => {
    const analyzed = await service.analyzeDocument(
      'insurer-target',
      textFile(
        'apolice-54.txt',
        'APÓLICE Nº 5400012345\nSegurado: Transportadora Horizonte Ltda\nCNPJ do Segurado: 12.345.678/0001-90\nRamo: 54 - RCTR-C\nLMI: R$ 1.500.000,00\nVigência: 01/01/2026 a 31/12/2026'
      )
    );

    const request = service.createMigrationRequest({
      requesterInsurerId: 'insurer-target',
      cnpj: '12.345.678/0001-90',
      selectedRamos: ['54'],
      documentIds: [analyzed.id],
      termAccepted: true,
      scheduledStart: '2026-10-01'
    });

    expect(request.status).toBe('PROGRAMADA');
    expect(request.analysis_result).toBe('APROVADA');
    const originNotices = service.listOriginNotices('insurer-origin');
    expect(originNotices).toHaveLength(1);
    expect(originNotices[0]).toMatchObject({
      cnpj: '12345678000190',
      insured_name: 'Transportadora Horizonte Ltda',
      ramos: ['54'],
      scheduled_start: '2026-10-01'
    });
    expect(originNotices[0]).not.toHaveProperty('origin_insurer_id');
    expect(originNotices[0]).not.toHaveProperty('migration_request_id');
    expect(originNotices[0]).not.toHaveProperty('requester_insurer_id');
    expect(service.listOriginNotices('insurer-target')).toEqual([]);
  });

  test('não permite migrar ramo que não existe no cadastro de origem', async () => {
    const analyzed = await service.analyzeDocument(
      'insurer-target',
      textFile(
        'apolice-59.txt',
        'APÓLICE Nº 5900012345\nSegurado: Transportadora Horizonte Ltda\nCNPJ do Segurado: 12.345.678/0001-90\nRamo: 59 - RC-V\nVigência: 01/01/2026 a 31/12/2026'
      )
    );

    expect(() => service.createMigrationRequest({
      requesterInsurerId: 'insurer-target',
      cnpj: '12345678000190',
      selectedRamos: ['59'],
      documentIds: [analyzed.id],
      termAccepted: true
    })).toThrow(expect.objectContaining<Partial<OnboardingMigrationError>>({ code: 'MIGRATION_BRANCH_NOT_ELIGIBLE' }));
  });

  test('imagem sem OCR vira revisão manual, nunca aprovação simulada pelo nome do arquivo', async () => {
    const analyzed = await service.analyzeDocument('insurer-target', {
      originalname: 'apolice-aprovada-54.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from([1, 2, 3, 4, 5])
    });

    expect(analyzed.extraction_level).toBe('INSUFICIENTE');
    expect(analyzed.migration_proof_eligible).toBe(false);
    expect(analyzed.analysis_warnings.join(' ')).toContain('OCR');

    const request = service.createMigrationRequest({
      requesterInsurerId: 'insurer-target',
      cnpj: '12345678000190',
      selectedRamos: ['54'],
      documentIds: [analyzed.id],
      termAccepted: true,
      scheduledStart: '2026-10-01'
    });
    expect(request.analysis_result).toBe('REVISAO_MANUAL');
    expect(request.status).toBe('DOCUMENTACAO_EM_ANALISE');
  });

  test('efetiva todos os ramos somente depois do onboarding completo e da data programada', async () => {
    const analyzed = await service.analyzeDocument(
      'insurer-target',
      textFile(
        'apolice-54-55.txt',
        'APÓLICE Nº 54550012345\nSegurado: Transportadora Horizonte Ltda\nCNPJ do Segurado: 12.345.678/0001-90\nRamos: 54 - RCTR-C e 55 - RCDC\nLMI: R$ 1.500.000,00\nVigência: 01/01/2026 a 31/12/2026'
      )
    );
    const request = service.createMigrationRequest({
      requesterInsurerId: 'insurer-target',
      cnpj: '12345678000190',
      selectedRamos: ['54', '55'],
      documentIds: [analyzed.id],
      termAccepted: true,
      scheduledStart: '2026-10-01'
    });

    service.completeOnboarding(request.id, 'insurer-target', ['target-54', 'target-55']);

    expect(() => service.effectMigration(request.id, 'insurer-target', new Date('2026-09-30T23:59:59.000Z')))
      .toThrow(expect.objectContaining<Partial<OnboardingMigrationError>>({ code: 'MIGRATION_NOT_DUE' }));
    expect(dbStore.policies.find((item) => item.id === 'source-54')?.status).toBe('ATIVA');
    expect(dbStore.policies.find((item) => item.id === 'source-55')?.status).toBe('ATIVA');

    const effective = service.effectMigration(request.id, 'insurer-target', new Date('2026-10-01T00:00:00.000Z'));
    expect(effective.status).toBe('EFETIVADA');
    expect(dbStore.policies.find((item) => item.id === 'source-54')?.status).toBe('INATIVA');
    expect(dbStore.policies.find((item) => item.id === 'source-55')?.status).toBe('INATIVA');
    expect(dbStore.policies.find((item) => item.id === 'target-54')?.status).toBe('ATIVA');
    expect(dbStore.policies.find((item) => item.id === 'target-55')?.status).toBe('ATIVA');
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });
});
