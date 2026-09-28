import { AverbacaoService } from '../averbacao';
import { dbStore } from '../dbStore';
import { DocumentIngestionService } from './documentIngestion';

describe('DocumentIngestionService', () => {
  beforeEach(() => {
    dbStore.fiscalDocuments = [];
    dbStore.rawXmlStore = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.fiscalDocuments = [];
    dbStore.rawXmlStore = [];
    jest.restoreAllMocks();
  });

  it('persiste o XML antes do motor e reutiliza raw_xml_id na averbação', () => {
    const processSpy = jest.spyOn(AverbacaoService, 'process').mockReturnValue({
      status: 'sucesso',
      codigo: 'SUC-2000',
      mensagem: 'Averbação realizada.',
      averbacao_id: 'avb-id-1',
      numero_averbacao: 'AV-1'
    });

    const result = DocumentIngestionService.processXml({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      capture_mode: 'OUTBOUND',
      app_base_url: 'http://localhost:3000',
      ramo: 'RCTRC',
      policy_id: 'policy-1',
      xml_content: '<cteProc />',
      connector_id: 'connector-1'
    });

    expect(result.numero_averbacao).toBe('AV-1');
    expect(dbStore.rawXmlStore).toHaveLength(1);
    expect(processSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        ramo: 'RCTRC',
        policy_id: 'policy-1',
        xml_content: '<cteProc />',
        raw_xml_id: dbStore.rawXmlStore[0]?.id
      }),
      'http://localhost:3000'
    );

    expect(dbStore.fiscalDocuments[0]).toMatchObject({
      source: 'SEFAZ',
      capture_mode: 'OUTBOUND',
      status: 'AVERBADO',
      raw_xml_id: dbStore.rawXmlStore[0]?.id,
      connector_id: 'connector-1',
      policy_ids_attempted: ['policy-1'],
      averbacao_ids: ['avb-id-1']
    });
  });

  it('mantém XML malformado reprocessável e marca o documento como ERRO', () => {
    const processSpy = jest.spyOn(AverbacaoService, 'process');

    DocumentIngestionService.processXml({
      tenant_id: 'tenant-1',
      source: 'API',
      app_base_url: 'http://localhost:3000',
      ramo: 'RCTRC',
      xml_content: '<xml-invalido'
    });

    expect(processSpy).not.toHaveBeenCalled();
    expect(dbStore.rawXmlStore).toHaveLength(1);
    expect(dbStore.fiscalDocuments[0]).toMatchObject({
      status: 'ERRO',
      capture_mode: 'MANUAL',
      raw_xml_id: dbStore.rawXmlStore[0]?.id,
      codigo_resultado: 'ERR-4005'
    });
  });

  it('mantém documento sem apólice com raw XML para reprocessamento futuro', () => {
    const [result] = DocumentIngestionService.processXmlBatch({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      app_base_url: 'http://localhost:3000',
      files: [{
        filename: 'cte.xml',
        xml_content: '<cteProc />',
        capture_mode: 'OUTBOUND'
      }],
      policies: []
    });

    expect(result?.aceito_em_alguma_apolice).toBe(false);
    expect(dbStore.fiscalDocuments[0]).toMatchObject({
      status: 'RECUSADO',
      codigo_resultado: 'NO_POLICY_CANDIDATE',
      capture_mode: 'OUTBOUND',
      raw_xml_id: expect.any(String)
    });
    expect(dbStore.rawXmlStore).toHaveLength(1);
  });

  it('deduplica entre canais antes de chamar o motor', () => {
    jest.spyOn(AverbacaoService, 'process').mockReturnValueOnce({
      status: 'sucesso',
      codigo: 'SUC-2000',
      mensagem: 'Averbado.',
      averbacao_id: 'avb-1'
    });
    const spy = jest.spyOn(AverbacaoService, 'process');

    DocumentIngestionService.processXmlBatch({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      app_base_url: 'http://localhost:3000',
      files: [{ filename: 'cte-sefaz.xml', xml_content: '<cteProc />', capture_mode: 'OUTBOUND' }],
      policies: [{ id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC' }]
    });

    const [duplicate] = DocumentIngestionService.processXmlBatch({
      tenant_id: 'tenant-1',
      source: 'PORTAL',
      app_base_url: 'http://localhost:3000',
      files: [{ filename: 'cte-portal.xml', xml_content: '<cteProc />' }],
      policies: [{ id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC' }]
    });

    expect(duplicate?.duplicate).toBe(true);
    expect(duplicate?.duplicate_of_id).toBeDefined();
    expect(dbStore.fiscalDocuments[0]?.status).toBe('DUPLICADO');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('permite reprocessar o mesmo XML quando surgiu uma apólice ainda não tentada', () => {
    jest.spyOn(AverbacaoService, 'process').mockReturnValue({
      status: 'sucesso',
      codigo: 'SUC-2000',
      mensagem: 'Averbado.',
      averbacao_id: 'avb-new'
    });

    dbStore.fiscalDocuments.push({
      id: 'old',
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      capture_mode: 'OUTBOUND',
      status: 'AVERBADO',
      content_hash_sha256: 'will-be-replaced',
      raw_xml_id: 'raw-old',
      policy_ids_attempted: ['old-policy'],
      averbacao_ids: ['old-avb'],
      received_at: '2026-09-27T00:00:00.000Z'
    });

    // Replace with the actual hash so only policy coverage controls deduplication.
    const crypto = require('crypto') as typeof import('crypto');
    dbStore.fiscalDocuments[0]!.content_hash_sha256 = crypto
      .createHash('sha256')
      .update('<cteProc />', 'utf8')
      .digest('hex');

    const [result] = DocumentIngestionService.processXmlBatch({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      app_base_url: 'http://localhost:3000',
      files: [{ filename: 'cte.xml', xml_content: '<cteProc />', capture_mode: 'OUTBOUND' }],
      policies: [{ id: 'new-policy', numero_apolice: 'NEW', ramo: 'RCTRC' }]
    });

    expect(result?.duplicate).not.toBe(true);
    expect(result?.tentativas).toHaveLength(1);
  });
});
