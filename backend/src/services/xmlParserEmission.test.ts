import { XMLParserService } from './xmlParser';
describe('data de emissão NFS-e', () => {
  it('prioriza emissão, mesmo quando o processamento ocorre no dia seguinte', () => {
    const xml = '<Nfse><infNfse><numero>1</numero><dhProc>2026-09-29T01:00:00-03:00</dhProc><dataEmissao>2026-09-28T23:00:00-03:00</dataEmissao></infNfse></Nfse>';
    expect(XMLParserService.parse(xml).dataEmissao).toBe('2026-09-28T23:00:00-03:00');
  });
  it.each(['<Nfse><infNfse><dhProc>2026-09-29T01:00:00-03:00</dhProc></infNfse></Nfse>', '<DPS><infDPS><dCompet>2026-09-01</dCompet></infDPS></DPS>'])('não substitui emissão por processamento ou competência', xml => {
    expect(XMLParserService.parse(xml).dataEmissao).toBeUndefined();
  });
});
