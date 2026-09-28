import { dbStore } from './dbStore';
import { ConnectorFiscalService } from './connectorFiscalService';
import { DocumentIngestionService } from './ingestion/documentIngestion';
import { Connector } from '../types';

describe('ConnectorFiscalService', () => {
  const connector: Connector = {
    id: 'connector-1',
    tenant_id: 'tenant-1',
    device_id: 'pc-1',
    device_name: 'PC 1',
    version: '1.0.0',
    os: 'windows',
    capabilities: ['NFE_DFE', 'CTE_DFE', 'MDFE_DFE'],
    status: 'ATIVO',
    device_token_hash: 'hash',
    sefaz_status: 'ONLINE',
    certificate_status: 'VALID',
    created_at: '2026-09-28T00:00:00.000Z'
  };

  beforeEach(() => {
    dbStore.policies = [];
    dbStore.fiscalDocuments = [];
  });

  afterEach(() => {
    dbStore.policies = [];
    dbStore.fiscalDocuments = [];
    jest.restoreAllMocks();
  });

  it('seleciona no máximo uma apólice por ramo e prefere a ativa não vencida', () => {
    dbStore.policies = [
      {
        id: 'rctrc-old',
        numero_apolice: 'OLD',
        ramo: 'RCTRC',
        tenant_id: 'tenant-1',
        insurer_id: 'i1',
        broker_id: 'b1',
        status: 'VENCIDA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2025-01-01',
        vigencia_fim: '2025-12-31',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'rctrc-current',
        numero_apolice: 'CURRENT',
        ramo: 'RCTRC',
        tenant_id: 'tenant-1',
        insurer_id: 'i1',
        broker_id: 'b1',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01',
        vigencia_fim: '2027-12-31',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'rcdc',
        numero_apolice: 'RCDC',
        ramo: 'RCDC',
        tenant_id: 'tenant-1',
        insurer_id: 'i1',
        broker_id: 'b1',
        status: 'ATIVA',
        permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01',
        vigencia_fim: '2027-12-31',
        aceita_averbacao_como_destinatario: false
      }
    ] as any;

    const selected = ConnectorFiscalService.resolveAutomaticPolicies('tenant-1');

    expect(selected).toEqual([
      { id: 'rctrc-current', numero_apolice: 'CURRENT', ramo: 'RCTRC' },
      { id: 'rcdc', numero_apolice: 'RCDC', ramo: 'RCDC' }
    ]);
  });

  it('não reprocessa o mesmo provider + NSU + conteúdo no mesmo connector', () => {
    const xml = '<cteProc>same</cteProc>';
    const crypto = require('crypto') as typeof import('crypto');
    const hash = crypto.createHash('sha256').update(xml, 'utf8').digest('hex');

    dbStore.fiscalDocuments = [{
      id: 'fd-1',
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      status: 'AVERBADO',
      content_hash_sha256: hash,
      original_filename: 'CTE-10.xml',
      nsu: '10',
      connector_id: 'connector-1',
      external_id: 'CTE:10',
      policy_ids_attempted: [],
      averbacao_ids: [],
      received_at: '2026-09-28T00:00:00.000Z'
    }];

    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch');

    const [result] = ConnectorFiscalService.ingestBatch({
      connector,
      provider: 'CTE',
      app_base_url: 'http://localhost:3000',
      documents: [{ nsu: '10', xml }]
    });

    expect(result).toMatchObject({
      nsu: '10',
      duplicate: true,
      fiscal_document_id: 'fd-1',
      status: 'AVERBADO'
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('encaminha documento novo para o pipeline com origem SEFAZ e external id estável', () => {
    dbStore.policies = [{
      id: 'p1',
      numero_apolice: 'AP-1',
      ramo: 'RCTRC',
      tenant_id: 'tenant-1',
      insurer_id: 'i1',
      broker_id: 'b1',
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01',
      vigencia_fim: '2027-12-31',
      aceita_averbacao_como_destinatario: false
    }] as any;

    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch').mockReturnValue([{
      fiscal_document_id: 'fd-new',
      arquivo: 'NFE-99.xml',
      aceito_em_alguma_apolice: true,
      tentativas: []
    }]);

    const [result] = ConnectorFiscalService.ingestBatch({
      connector,
      provider: 'NFE',
      app_base_url: 'http://localhost:3000',
      documents: [{ nsu: '99', xml: '<nfeProc />' }]
    });

    expect(result?.duplicate).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      files: [{
        filename: 'NFE-99.xml',
        xml_content: '<nfeProc />',
        nsu: '99',
        connector_id: 'connector-1',
        external_id: 'NFE:99'
      }]
    }));
  });
});
