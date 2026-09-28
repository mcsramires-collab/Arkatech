import zlib from 'zlib';
import { XMLParser } from 'fast-xml-parser';
import { MockSefazService } from './mockSefazService';
import { MOCK_CNPJ } from './fixtures';

describe('MockSefazService', () => {
  let service: MockSefazService;

  beforeEach(() => {
    service = new MockSefazService();
  });

  it('retorna 138 com documentos sequenciais e docZip GZip/Base64', () => {
    const result = service.distribute({
      provider: 'CTE',
      cnpj: MOCK_CNPJ,
      ult_nsu: '0'
    }, 1_000);

    expect(result.cStat).toBe(138);
    expect(result.documents).toHaveLength(2);
    expect(result.ultNSU).toBe('000000000000002');
    expect(result.maxNSU).toBe('000000000000002');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false
    });
    const parsed = parser.parse(result.xml);
    const first = parsed.retDistDFeInt.loteDistDFeInt.docZip[0];

    expect(first['@_NSU']).toBe('000000000000001');
    const xml = zlib.gunzipSync(Buffer.from(first['#text'], 'base64')).toString('utf8');
    expect(xml).toContain('<cteProc');
  });

  it('retorna 137 no fim da fila e 656 se consultar novamente antes de uma hora', () => {
    const first = service.distribute({
      provider: 'NFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: '0'
    }, 1_000);
    expect(first.cStat).toBe(138);
    expect(first.ultNSU).toBe('000000000000001');

    const noDocuments = service.distribute({
      provider: 'NFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: first.ultNSU
    }, 2_000);
    expect(noDocuments.cStat).toBe(137);

    const abusive = service.distribute({
      provider: 'NFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: noDocuments.ultNSU
    }, 3_000);
    expect(abusive.cStat).toBe(656);
  });

  it('bloqueia consulta fora da sequencia de NSU com 656', () => {
    const result = service.distribute({
      provider: 'MDFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: '999'
    }, 1_000);

    expect(result.cStat).toBe(656);
    expect(result.xMotivo).toContain('ultNSU');
  });

  it('permite nova consulta apos uma hora do cStat 137', () => {
    const first = service.distribute({
      provider: 'MDFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: '0'
    }, 1_000);
    expect(first.cStat).toBe(138);

    const noDocuments = service.distribute({
      provider: 'MDFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: first.ultNSU
    }, 2_000);
    expect(noDocuments.cStat).toBe(137);

    const afterOneHour = service.distribute({
      provider: 'MDFE',
      cnpj: MOCK_CNPJ,
      ult_nsu: noDocuments.ultNSU
    }, 2_000 + 60 * 60 * 1000);

    expect(afterOneHour.cStat).toBe(137);
  });
});
