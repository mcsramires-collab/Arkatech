import { AverbacaoService } from '../averbacao';
import { dbStore } from '../dbStore';
import { DocumentIngestionService } from './documentIngestion';

describe('DocumentIngestionService', () => {
  beforeEach(() => {
    dbStore.fiscalDocuments = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.fiscalDocuments = [];
    jest.restoreAllMocks();
  });

  it('encaminha XML para o AverbacaoService e registra o ciclo de vida do documento', () => {
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
      app_base_url: 'http://localhost:3000',
      ramo: 'RCTRC',
      policy_id: 'policy-1',
      xml_content: '<cteProc />',
      nsu: '123',
      connector_id: 'connector-1'
    });

    expect(result.numero_averbacao).toBe('AV-1');
    expect(processSpy).toHaveBeenCalledWith(
      {
        tenant_id: 'tenant-1',
        ramo: 'RCTRC',
        policy_id: 'policy-1',
        xml_content: '<cteProc />'
      },
      'http://localhost:3000'
    );

    expect(dbStore.fiscalDocuments).toHaveLength(1);
    expect(dbStore.fiscalDocuments[0]).toMatchObject({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      status: 'AVERBADO',
      nsu: '123',
      connector_id: 'connector-1',
      policy_ids_attempted: ['policy-1'],
      averbacao_ids: ['avb-id-1'],
      codigo_resultado: 'SUC-2000'
    });
    expect(dbStore.fiscalDocuments[0]?.processed_at).toBeDefined();
  });

  it('marca XML malformado como ERRO no histórico de ingestão', () => {
    jest.spyOn(AverbacaoService, 'process').mockReturnValue({
      status: 'erro',
      codigo: 'ERR-4005',
      mensagem: 'XML inválido.'
    });

    DocumentIngestionService.processXml({
      tenant_id: 'tenant-1',
      source: 'API',
      app_base_url: 'http://localhost:3000',
      ramo: 'RCTRC',
      xml_content: '<xml-invalido'
    });

    expect(dbStore.fiscalDocuments[0]?.status).toBe('ERRO');
    expect(dbStore.fiscalDocuments[0]?.content_hash_sha256).toHaveLength(64);
  });

  it('mantém um documento por arquivo e consolida tentativas de múltiplas apólices', () => {
    jest
      .spyOn(AverbacaoService, 'process')
      .mockReturnValueOnce({
        status: 'erro',
        codigo: 'ERR-1',
        mensagem: 'Recusado.'
      })
      .mockReturnValueOnce({
        status: 'sucesso',
        codigo: 'SUC-2000',
        mensagem: 'Averbado.',
        averbacao_id: 'avb-id-2',
        numero_averbacao: 'AV-2'
      });

    const [result] = DocumentIngestionService.processXmlBatch({
      tenant_id: 'tenant-1',
      source: 'PORTAL',
      app_base_url: 'http://localhost:3000',
      files: [{ filename: 'cte.xml', xml_content: '<cteProc />' }],
      policies: [
        { id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC' },
        { id: 'p2', numero_apolice: 'AP-2', ramo: 'RCDC' }
      ]
    });

    expect(result?.arquivo).toBe('cte.xml');
    expect(result?.fiscal_document_id).toBe(dbStore.fiscalDocuments[0]?.id);
    expect(result?.aceito_em_alguma_apolice).toBe(true);
    expect(result?.tentativas).toHaveLength(2);
    expect(result?.tentativas[1]?.numero_averbacao).toBe('AV-2');

    expect(dbStore.fiscalDocuments).toHaveLength(1);
    expect(dbStore.fiscalDocuments[0]).toMatchObject({
      status: 'AVERBADO',
      original_filename: 'cte.xml',
      policy_ids_attempted: ['p1', 'p2'],
      averbacao_ids: ['avb-id-2']
    });
  });

  it('consolida tentativas duplicadas como DUPLICADO', () => {
    jest.spyOn(AverbacaoService, 'process').mockReturnValue({
      status: 'erro',
      codigo: 'ERR-4007',
      mensagem: 'Documento já averbado.'
    });

    DocumentIngestionService.processXmlBatch({
      tenant_id: 'tenant-1',
      source: 'PORTAL',
      app_base_url: 'http://localhost:3000',
      files: [{ filename: 'cte.xml', xml_content: '<cteProc />' }],
      policies: [{ id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC' }]
    });

    expect(dbStore.fiscalDocuments[0]?.status).toBe('DUPLICADO');
  });
});
