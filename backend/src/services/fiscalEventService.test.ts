import { CancelamentoService } from './cancelamento';
import { dbStore } from './dbStore';
import { FiscalEventService } from './fiscalEventService';
import { Connector } from '../types';

describe('FiscalEventService', () => {
  const connector: Connector = {
    id: 'connector-1',
    tenant_id: 'tenant-1',
    device_id: 'pc-1',
    device_name: 'PC 1',
    version: '1.0.0',
    os: 'windows',
    capabilities: ['CTE_DFE'],
    status: 'ATIVO',
    device_token_hash: 'hash',
    sefaz_status: 'ONLINE',
    certificate_status: 'VALID',
    created_at: '2026-09-28T00:00:00.000Z'
  };

  const chave = '35123456789012345678901234567890123456789012';
  const xmlEvento = `<procEventoCTe>
    <eventoCTe>
      <infEvento>
        <tpEvento>110111</tpEvento>
        <chCTe>${chave}</chCTe>
        <dhEvento>2026-09-28T00:00:00-03:00</dhEvento>
        <detEvento><evCancCTe><xJust>Cancelamento autorizado</xJust></evCancCTe></detEvento>
      </infEvento>
    </eventoCTe>
    <retEventoCTe><infEvento><nProt>135260000009999</nProt></infEvento></retEventoCTe>
  </procEventoCTe>`;

  beforeEach(() => {
    dbStore.fiscalEvents = [];
    dbStore.rawXmlStore = [];
    dbStore.averbacoes = [
      { id: 'avb-rctrc', tenant_id: 'tenant-1', policy_id: 'p1', status: 'SUCESSO', chave_documento: chave },
      { id: 'avb-rcdc', tenant_id: 'tenant-1', policy_id: 'p2', status: 'SUCESSO', chave_documento: chave }
    ] as any;
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.fiscalEvents = [];
    dbStore.rawXmlStore = [];
    dbStore.averbacoes = [];
    jest.restoreAllMocks();
  });

  it('cancela todas as averbações ativas da mesma chave usando ator SEFAZ', () => {
    const cancelSpy = jest.spyOn(CancelamentoService, 'processar').mockImplementation(({ averbacaoAnterior }) => ({
      status: 'sucesso',
      codigo: 'SUC-2002',
      mensagem: 'Cancelado.',
      averbacao: averbacaoAnterior
    }));

    const result = FiscalEventService.process({
      connector,
      provider: 'CTE',
      event: { nsu: '50', xml: xmlEvento }
    });

    expect(result.status).toBe('PROCESSADO');
    expect(result.averbacao_ids).toEqual(['avb-rctrc', 'avb-rcdc']);
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    expect(cancelSpy).toHaveBeenCalledWith(expect.objectContaining({ requisitante: 'SEFAZ' }));
    expect(dbStore.fiscalEvents[0]).toMatchObject({
      tenant_id: 'tenant-1',
      provider: 'CTE',
      tipo_evento: '110111',
      chave_documento: chave,
      status: 'PROCESSADO',
      raw_xml_id: expect.any(String)
    });
  });

  it('retém evento de cancelamento sem averbação correspondente como IGNORADO', () => {
    dbStore.averbacoes = [];

    const result = FiscalEventService.process({
      connector,
      provider: 'CTE',
      event: { xml: xmlEvento }
    });

    expect(result.status).toBe('IGNORADO');
    expect(result.mensagem).toContain('nenhuma averbação ativa');
    expect(dbStore.rawXmlStore).toHaveLength(1);
  });

  it('não processa duas vezes o mesmo evento', () => {
    jest.spyOn(CancelamentoService, 'processar').mockImplementation(({ averbacaoAnterior }) => ({
      status: 'sucesso',
      codigo: 'SUC-2002',
      mensagem: 'Cancelado.',
      averbacao: averbacaoAnterior
    }));

    FiscalEventService.process({ connector, provider: 'CTE', event: { nsu: '50', xml: xmlEvento } });
    const duplicate = FiscalEventService.process({
      connector,
      provider: 'CTE',
      event: { nsu: '50', xml: xmlEvento }
    });

    expect(duplicate.status).toBe('DUPLICADO');
    expect(dbStore.fiscalEvents).toHaveLength(2);
  });
});
