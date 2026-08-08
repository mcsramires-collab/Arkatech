import { dbStore } from './dbStore';
import { TipoDocumento } from '../types';

export class MockGeneratorService {
  /**
   * Gera um documento XML Sefaz fictício porém perfeitamente válido para testes.
   * TRAVA DE SEGURANÇA: Funciona exclusivamente se o cliente pertencer ao ambiente = 'teste'.
   */
  public static generateMockXML(tenantId: string, tipoDoc: TipoDocumento = 'CTE'): string {
    const tenant = dbStore.tenants.find((t) => t.id === tenantId);

    if (!tenant) {
      throw new Error('Cliente não encontrado.');
    }

    if (tenant.ambiente !== 'teste') {
      throw new Error(
        'ALERTA DE SEGURANÇA: A geração de dados fictícios (MOCK) é estritamente proibida em clientes do ambiente de PRODUÇÃO.'
      );
    }

    const docNum = Math.floor(100000 + Math.random() * 900000);
    const chave = `352608${tenant.cnpj.replace(/\D/g, '')}57001000${docNum}10012345678`;
    const valorCarga = (Math.random() * 50000 + 1000).toFixed(2);
    const dateISO = new Date().toISOString();

    if (tipoDoc === 'CTE') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<cteProc xmlns="http://www.portalfiscal.inf.br/cte" versao="4.00">
  <CTe>
    <infCte Id="CTe${chave}" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <cCT>12345678</cCT>
        <CFOP>5353</CFOP>
        <natOp>PRESTACAO DE SERVICO DE TRANSPORTE</natOp>
        <mod>57</mod>
        <serie>1</serie>
        <nCT>${docNum}</nCT>
        <dhEmi>${dateISO}</dhEmi>
        <tpImp>1</tpImp>
        <tpEmis>1</tpEmis>
      </ide>
      <emit>
        <CNPJ>${tenant.cnpj.replace(/\D/g, '')}</CNPJ>
        <xNome>${tenant.razao_social}</xNome>
      </emit>
      <vPrest>
        <vTPrest>${valorCarga}</vTPrest>
        <vRec>${valorCarga}</vRec>
      </vPrest>
      <infCTeNorm>
        <infCarga>
          <vCarga>${valorCarga}</vCarga>
          <proPred>Carga Geral Embalada</proPred>
        </infCarga>
      </infCTeNorm>
      <compl>
        <xObs>Averbação de Teste ARCKATECH - CTe Nº ${docNum}</xObs>
      </compl>
    </infCte>
  </CTe>
</cteProc>`;
    }

    if (tipoDoc === 'NFE') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave}" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <nNF>${docNum}</nNF>
        <dhEmi>${dateISO}</dhEmi>
      </ide>
      <emit>
        <CNPJ>${tenant.cnpj.replace(/\D/g, '')}</CNPJ>
        <xNome>${tenant.razao_social}</xNome>
      </emit>
      <total>
        <ICMSTot>
          <vProd>${valorCarga}</vProd>
          <vNF>${valorCarga}</vNF>
        </ICMSTot>
      </total>
      <infAdic>
        <infCpl>Averbação de Teste NFe Nº ${docNum}</infCpl>
      </infAdic>
    </infNFe>
  </NFe>
</nfeProc>`;
    }

    // NFSe Fallback
    return `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.portalfiscal.inf.br/nfse">
  <Nfse>
    <infNfse>
      <numero>${docNum}</numero>
      <valores>
        <vServicos>${valorCarga}</vServicos>
      </valores>
    </infNfse>
  </Nfse>
</CompNfse>`;
  }
}
