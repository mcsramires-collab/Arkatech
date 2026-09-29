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

  const cteSemAutorizacao = `<CTe>
    <infCte Id="CTe35123456789012345678901234567890123456789013">
      <ide><nCT>124</nCT><serie>1</serie><tpAmb>2</tpAmb></ide>
      <emit><CNPJ>12345678000190</CNPJ></emit>
      <vPrest><vRec>1000.00</vRec></vPrest>
    </infCte>
  </CTe>`;

  const cteAutorizado = `<cteProc>
    <CTe><infCte Id="CTe35123456789012345678901234567890123456789012">
      <ide><nCT>123</nCT><serie>1</serie><tpAmb>2</tpAmb></ide>
      <emit><CNPJ>12345678000190</CNPJ></emit>
      <vPrest><vRec>1000.00</vRec></vPrest>
    </infCte></CTe>
    <protCTe><infProt>
      <chCTe>35123456789012345678901234567890123456789012</chCTe>
      <nProt>135260000000123</nProt>
      <cStat>100</cStat>
    </infProt></protCTe>
  </cteProc>`;

  beforeEach(() => {
    dbStore.policies = [];
    dbStore.policyBusinessSettings = [];
    dbStore.fiscalDocuments = [];
    dbStore.rawXmlStore = [];
  });

  afterEach(() => {
    dbStore.policies = [];
    dbStore.policyBusinessSettings = [];
    dbStore.fiscalDocuments = [];
    dbStore.rawXmlStore = [];
    jest.restoreAllMocks();
  });

  it('seleciona no máximo uma apólice por ramo e respeita tipos de documento configurados', () => {
    dbStore.policies = [
      {
        id: 'rctrc-old', numero_apolice: 'OLD', ramo: 'RCTRC', tenant_id: 'tenant-1',
        insurer_id: 'i1', broker_id: 'b1', status: 'VENCIDA', permitir_inativo_vencido: false,
        vigencia_inicio: '2025-01-01', vigencia_fim: '2025-12-31',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'rctrc-current', numero_apolice: 'CURRENT', ramo: 'RCTRC', tenant_id: 'tenant-1',
        insurer_id: 'i1', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'rcdc', numero_apolice: 'RCDC', ramo: 'RCDC', tenant_id: 'tenant-1',
        insurer_id: 'i1', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
        aceita_averbacao_como_destinatario: false
      }
    ] as any;

    dbStore.policyBusinessSettings = [
      { id: 's1', policy_id: 'rctrc-current', config: { 'regras:documentos-aceitos': ['CT-e', 'NF-e'] }, updated_at: '' },
      { id: 's2', policy_id: 'rcdc', config: { 'regras:documentos-aceitos': ['CT-e'] }, updated_at: '' }
    ] as any;

    expect(ConnectorFiscalService.resolveAutomaticPolicies('tenant-1', 'NFE', '2026-09-28')).toEqual([
      { id: 'rctrc-current', numero_apolice: 'CURRENT', ramo: 'RCTRC' }
    ]);

    expect(ConnectorFiscalService.resolveAutomaticPolicies('tenant-1', 'CTE', '2026-09-28')).toEqual([
      { id: 'rctrc-current', numero_apolice: 'CURRENT', ramo: 'RCTRC' },
      { id: 'rcdc', numero_apolice: 'RCDC', ramo: 'RCDC' }
    ]);
  });

  it('aceita captura OUTBOUND sem NSU e envia ao pipeline central', () => {
    dbStore.policies = [{
      id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC', tenant_id: 'tenant-1',
      insurer_id: 'i1', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
      aceita_averbacao_como_destinatario: false
    }] as any;

    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch').mockReturnValue([{
      fiscal_document_id: 'fd-new',
      arquivo: 'CTE-outbound.xml',
      aceito_em_alguma_apolice: true,
      tentativas: []
    }]);

    const [result] = ConnectorFiscalService.ingestBatch({
      connector,
      provider: 'CTE',
      capture_mode: 'OUTBOUND',
      app_base_url: 'http://localhost:3000',
      documents: [{ external_id: 'emissor-123', xml: cteAutorizado }]
    });

    expect(result?.duplicate).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: 'tenant-1',
      source: 'SEFAZ',
      files: [expect.objectContaining({
        filename: 'CTE-emissor-123.xml',
        capture_mode: 'OUTBOUND',
        external_id: 'emissor-123'
      })]
    }));
  });

  it('não averba OUTBOUND sem protocolo/status de autorização do SEFAZ', () => {
    dbStore.policies = [{
      id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC', tenant_id: 'tenant-1',
      insurer_id: 'i1', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
      aceita_averbacao_como_destinatario: false
    }] as any;

    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch').mockReturnValue([{
      fiscal_document_id: 'fd-not-authorized',
      arquivo: 'CTE-outbound.xml',
      aceito_em_alguma_apolice: false,
      tentativas: []
    }]);

    ConnectorFiscalService.ingestBatch({
      connector,
      provider: 'CTE',
      capture_mode: 'OUTBOUND',
      app_base_url: 'http://localhost:3000',
      documents: [{ external_id: 'emissor-rejeitado', xml: cteSemAutorizacao }]
    });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      policies: [],
      no_policy_status: 'IGNORADO',
      no_policy_code: 'SEFAZ_NOT_AUTHORIZED'
    }));
  });

  it('ignora XML cujo tipo não corresponde ao provider declarado', () => {
    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch').mockReturnValue([{
      fiscal_document_id: 'fd-mismatch',
      arquivo: 'NFE-10.xml',
      aceito_em_alguma_apolice: false,
      tentativas: []
    }]);

    ConnectorFiscalService.ingestBatch({
      connector,
      provider: 'NFE',
      capture_mode: 'DISTRIBUTION',
      app_base_url: 'http://localhost:3000',
      documents: [{ nsu: '10', xml: cteAutorizado }]
    });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      policies: [],
      no_policy_status: 'IGNORADO',
      no_policy_code: 'PROVIDER_DOCUMENT_MISMATCH'
    }));
  });

  it('classifica tipo não configurado como IGNORADO em vez de tentar qualquer ramo', () => {
    dbStore.policies = [{
      id: 'p1', numero_apolice: 'AP-1', ramo: 'RCTRC', tenant_id: 'tenant-1',
      insurer_id: 'i1', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
      aceita_averbacao_como_destinatario: false
    }] as any;

    dbStore.policyBusinessSettings = [{
      id: 's1', policy_id: 'p1',
      config: { 'regras:documentos-aceitos': ['NF-e'] },
      updated_at: ''
    }] as any;

    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch').mockReturnValue([{
      fiscal_document_id: 'fd-ignore',
      arquivo: 'CTE-10.xml',
      aceito_em_alguma_apolice: false,
      tentativas: []
    }]);

    ConnectorFiscalService.ingestBatch({
      connector,
      provider: 'CTE',
      capture_mode: 'DISTRIBUTION',
      app_base_url: 'http://localhost:3000',
      documents: [{ nsu: '10', xml: cteSemAutorizacao }]
    });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      policies: [],
      no_policy_status: 'IGNORADO',
      no_policy_code: 'DOCUMENT_TYPE_NOT_CONFIGURED'
    }));
  });
  it('recusa seleção automática quando o mesmo ramo tem seguradoras diferentes', () => {
    dbStore.policies = [
      {
        id: 'p-a', numero_apolice: 'A', ramo: 'RCTRC', tenant_id: 'tenant-1',
        insurer_id: 'insurer-a', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
        aceita_averbacao_como_destinatario: false
      },
      {
        id: 'p-b', numero_apolice: 'B', ramo: 'RCTRC', tenant_id: 'tenant-1',
        insurer_id: 'insurer-b', broker_id: 'b1', status: 'ATIVA', permitir_inativo_vencido: false,
        vigencia_inicio: '2026-01-01', vigencia_fim: '2027-12-31',
        aceita_averbacao_como_destinatario: false
      }
    ] as any;

    expect(ConnectorFiscalService.resolveAutomaticPolicies('tenant-1', 'CTE', '2026-09-28')).toEqual([]);
  });
});

describe('matching histórico por emissão', () => {
  afterEach(() => { dbStore.policies = []; dbStore.policyBusinessSettings = []; jest.restoreAllMocks(); });
  it('encaminha OUTBOUND à apólice histórica e recusa ambiguidade no mesmo ramo', () => {
    const base = {tenant_id:'historic', insurer_id:'i1', ramo:'RCTRC', status:'ATIVA', numero_apolice:'TEST', vigencia_inicio:'2026-01-01', vigencia_fim:'2026-08-31'};
    dbStore.policies = [{...base, id:'old'}, {...base,id:'renewed',vigencia_inicio:'2026-09-01',vigencia_fim:'2027-08-31'}] as any;
    dbStore.policyBusinessSettings = [];
    const spy = jest.spyOn(DocumentIngestionService, 'processXmlBatch').mockReturnValue([{fiscal_document_id:'fd',arquivo:'test',aceito_em_alguma_apolice:true,tentativas:[]}]);
    ConnectorFiscalService.ingestBatch({connector:{tenant_id:'historic',id:'connector'} as Connector, provider:'CTE', capture_mode:'OUTBOUND', app_base_url:'http://localhost', documents:[{xml:'<cteProc><CTe><infCte><ide><dhEmi>2026-08-20T12:00:00-03:00</dhEmi></ide></infCte></CTe><protCTe><infProt><nProt>123</nProt><cStat>100</cStat></infProt></protCTe></cteProc>'}]});
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({policies:[expect.objectContaining({id:'old'})]}));
    dbStore.policies.push({...dbStore.policies[0]!, id:'overlap'});
    expect(ConnectorFiscalService.resolveAutomaticPolicies('historic','CTE','2026-08-20')).toEqual([]);
    expect(ConnectorFiscalService.resolveAutomaticPolicies('historic','CTE','invalid')).toEqual([]);
  });
});
