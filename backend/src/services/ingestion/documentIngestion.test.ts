import { AverbacaoService } from '../averbacao';
import { DocumentIngestionService } from './documentIngestion';

describe('DocumentIngestionService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('encaminha XML para o AverbacaoService sem alterar o contrato do motor', () => {
    const processSpy = jest.spyOn(AverbacaoService, 'process').mockReturnValue({
      status: 'sucesso',
      codigo: 'SUC-2000',
      mensagem: 'Averbação realizada.',
      numero_averbacao: 'AV-1'
    });

    const result = DocumentIngestionService.processXml({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      app_base_url: 'http://localhost:3000',
      ramo: 'RCTRC',
      policy_id: 'policy-1',
      xml_content: '<cteProc />'
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
  });

  it('mantém resultado por arquivo e por apólice no processamento em lote', () => {
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
    expect(result?.aceito_em_alguma_apolice).toBe(true);
    expect(result?.tentativas).toHaveLength(2);
    expect(result?.tentativas[1]?.numero_averbacao).toBe('AV-2');
  });
});
