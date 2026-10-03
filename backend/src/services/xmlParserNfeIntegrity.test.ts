import { XMLParserService } from './xmlParser';

describe('XMLParserService - integridade NF-e e relações fiscais', () => {
  it('extrai modFrete, autXML e transportador da NF-e', () => {
    const xml = `
      <nfeProc>
        <NFe>
          <infNFe Id="NFe35123456789012345678901234567890123456789012">
            <ide><nNF>123</nNF><serie>1</serie><dhEmi>2026-09-30T10:00:00-03:00</dhEmi><tpAmb>2</tpAmb></ide>
            <emit><CNPJ>11111111000111</CNPJ></emit>
            <dest><CNPJ>22222222000122</CNPJ></dest>
            <transp><modFrete>0</modFrete><transporta><CNPJ>33333333000133</CNPJ></transporta></transp>
            <autXML><CNPJ>44444444000144</CNPJ></autXML>
            <autXML><CPF>12345678901</CPF></autXML>
            <total><ICMSTot><vProd>1500.50</vProd><vNF>1500.50</vNF></ICMSTot></total>
          </infNFe>
        </NFe>
        <protNFe><infProt><chNFe>35123456789012345678901234567890123456789012</chNFe><nProt>135260000000001</nProt><cStat>100</cStat></infProt></protNFe>
      </nfeProc>`;

    const parsed = XMLParserService.parse(xml);
    expect(parsed.tipoDocumento).toBe('NFE');
    expect(parsed.cnpjTransportador).toBe('33333333000133');
    expect(parsed.modFrete).toBe('0');
    expect(parsed.autXmlIds).toEqual(['44444444000144', '12345678901']);
    expect(parsed.tagsMap.modFrete).toBe('0');
    expect(parsed.tagsMap.autXML).toEqual(['44444444000144', '12345678901']);
  });

  it('extrai NF-es referenciadas pelo CT-e', () => {
    const xml = `
      <CTe><infCte Id="CTe35123456789012345678901234567890123456789012">
        <ide><nCT>55</nCT><dhEmi>2026-09-30T10:00:00-03:00</dhEmi></ide>
        <emit><CNPJ>11111111000111</CNPJ></emit>
        <vPrest><vRec>900</vRec></vPrest>
        <infCTeNorm><infCarga><vCarga>900</vCarga></infCarga><infDoc>
          <infNFe><chave>35111111111111111111111111111111111111111111</chave></infNFe>
          <infNFe><chave>35222222222222222222222222222222222222222222</chave></infNFe>
        </infDoc></infCTeNorm>
      </infCte></CTe>`;

    const parsed = XMLParserService.parse(xml);
    expect(parsed.referencedNfeKeys).toEqual([
      '35111111111111111111111111111111111111111111',
      '35222222222222222222222222222222222222222222'
    ]);
  });

  it('extrai CT-es e NF-es agrupadas pelo MDF-e', () => {
    const xml = `
      <MDFe><infMDFe Id="MDFe35123456789012345678901234567890123456789012">
        <ide><nMDF>77</nMDF><dhEmi>2026-09-30T10:00:00-03:00</dhEmi></ide>
        <emit><CNPJ>11111111000111</CNPJ></emit>
        <tot><vCarga>5000</vCarga></tot>
        <infDoc><infMunDescarga>
          <infCTe><chCTe>35333333333333333333333333333333333333333333</chCTe></infCTe>
          <infNFe><chNFe>35444444444444444444444444444444444444444444</chNFe></infNFe>
        </infMunDescarga></infDoc>
      </infMDFe></MDFe>`;

    const parsed = XMLParserService.parse(xml);
    expect(parsed.referencedCteKeys).toEqual(['35333333333333333333333333333333333333333333']);
    expect(parsed.referencedNfeKeys).toEqual(['35444444444444444444444444444444444444444444']);
  });
});
