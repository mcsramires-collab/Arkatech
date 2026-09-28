export type MockProvider = 'NFE' | 'CTE' | 'MDFE';

export interface MockDfeDocument {
  nsu: number;
  schema: string;
  xml: string;
}

const CNPJ_TRANSPORTADORA = '12345678000190';
const CNPJ_CLIENTE = '99887766000155';

function chave(prefix: string, numero: number): string {
  const seed = (prefix + String(numero).padStart(40, '0')).replace(/\D/g, '');
  return (seed + '0'.repeat(44)).slice(0, 44);
}

export const MOCK_CNPJ = CNPJ_TRANSPORTADORA;

export const MOCK_DOCUMENTS: Record<MockProvider, MockDfeDocument[]> = {
  CTE: [
    {
      nsu: 1,
      schema: 'procCTe_v4.00.xsd',
      xml: `<cteProc versao="4.00">
  <CTe>
    <infCte Id="CTe${chave('57', 1001)}">
      <ide><cUF>35</cUF><CFOP>5353</CFOP><tpAmb>2</tpAmb><serie>1</serie><nCT>1001</nCT><dhEmi>2026-09-27T18:00:00-03:00</dhEmi><UFIni>SP</UFIni><UFFim>SP</UFFim></ide>
      <emit><CNPJ>${CNPJ_TRANSPORTADORA}</CNPJ></emit>
      <rem><CNPJ>${CNPJ_CLIENTE}</CNPJ></rem>
      <dest><CNPJ>11223344000188</CNPJ></dest>
      <vPrest><vRec>125000.00</vRec></vPrest>
      <infCTeNorm><infCarga><vCarga>125000.00</vCarga><proPred>ELETRONICOS</proPred></infCarga></infCTeNorm>
    </infCte>
  </CTe>
  <protCTe><infProt><chCTe>${chave('57', 1001)}</chCTe><nProt>135260000000001</nProt><dhRecbto>2026-09-27T18:00:05-03:00</dhRecbto></infProt></protCTe>
</cteProc>`
    },
    {
      nsu: 2,
      schema: 'procCTe_v4.00.xsd',
      xml: `<cteProc versao="4.00">
  <CTe>
    <infCte Id="CTe${chave('57', 1002)}">
      <ide><cUF>35</cUF><CFOP>6353</CFOP><tpAmb>2</tpAmb><serie>1</serie><nCT>1002</nCT><dhEmi>2026-09-27T18:10:00-03:00</dhEmi><UFIni>SP</UFIni><UFFim>PR</UFFim></ide>
      <emit><CNPJ>${CNPJ_TRANSPORTADORA}</CNPJ></emit>
      <rem><CNPJ>${CNPJ_CLIENTE}</CNPJ></rem>
      <dest><CNPJ>22334455000177</CNPJ></dest>
      <vPrest><vRec>84000.00</vRec></vPrest>
      <infCTeNorm><infCarga><vCarga>84000.00</vCarga><proPred>ALIMENTOS</proPred></infCarga></infCTeNorm>
    </infCte>
  </CTe>
  <protCTe><infProt><chCTe>${chave('57', 1002)}</chCTe><nProt>135260000000002</nProt><dhRecbto>2026-09-27T18:10:04-03:00</dhRecbto></infProt></protCTe>
</cteProc>`
    }
  ],
  NFE: [
    {
      nsu: 1,
      schema: 'procNFe_v4.00.xsd',
      xml: `<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave('35', 2001)}">
      <ide><tpAmb>2</tpAmb><serie>1</serie><nNF>2001</nNF><dhEmi>2026-09-27T17:50:00-03:00</dhEmi></ide>
      <emit><CNPJ>${CNPJ_CLIENTE}</CNPJ></emit>
      <dest><CNPJ>11223344000188</CNPJ></dest>
      <transp><transporta><CNPJ>${CNPJ_TRANSPORTADORA}</CNPJ></transporta></transp>
      <total><ICMSTot><vProd>95000.00</vProd><vNF>95000.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
  <protNFe><infProt><chNFe>${chave('35', 2001)}</chNFe><nProt>135260000000101</nProt><dhRecbto>2026-09-27T17:50:03-03:00</dhRecbto></infProt></protNFe>
</nfeProc>`
    }
  ],
  MDFE: [
    {
      nsu: 1,
      schema: 'procMDFe_v3.00.xsd',
      xml: `<mdfeProc versao="3.00">
  <MDFe>
    <infMDFe Id="MDFe${chave('58', 3001)}">
      <ide><tpAmb>2</tpAmb><serie>1</serie><nMDF>3001</nMDF><dhEmi>2026-09-27T18:20:00-03:00</dhEmi><UFIni>SP</UFIni><UFFim>PR</UFFim></ide>
      <emit><CNPJ>${CNPJ_TRANSPORTADORA}</CNPJ></emit>
      <tot><vCarga>209000.00</vCarga></tot>
    </infMDFe>
  </MDFe>
  <protMDFe><infProt><chMDFe>${chave('58', 3001)}</chMDFe><nProt>135260000000201</nProt><dhRecbto>2026-09-27T18:20:05-03:00</dhRecbto></infProt></protMDFe>
</mdfeProc>`
    }
  ]
};
