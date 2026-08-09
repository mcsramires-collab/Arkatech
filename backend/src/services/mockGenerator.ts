import { dbStore } from './dbStore';
import { TipoDocumento } from '../types';

export interface MockGenerationOptions {
  tenantId: string;
  tipoDoc: TipoDocumento;
  policyId?: string;
  incluirVariaveisApolice?: boolean;
  omitirObrigatorias?: string[]; // nomes de variáveis a propositalmente OMITIR (para testar recusa)
}

export class MockGeneratorService {
  /**
   * Monta a string do campo de observação (xObs/infCpl) embutindo as variáveis
   * de apólice no formato "NOME=valor; NOME2=valor2", que o xmlParser sabe ler de volta.
   */
  private static buildObsField(policyId: string | undefined, omitir: string[] = []): string {
    if (!policyId) return '';
    const rules = dbStore.policyRules.filter((r) => r.policy_id === policyId);
    const pairs = rules
      .filter((r) => !omitir.includes(r.nome_variavel))
      .map((r) => `${r.nome_variavel}=${r.exemplo_preenchimento || 'VALOR_EXEMPLO'}`);
    return pairs.join('; ');
  }

  /**
   * Gera um documento XML Sefaz fictício porém estruturalmente válido para testes,
   * com base no cadastro do transportador (tenant) e, opcionalmente, da apólice usada.
   * TRAVA DE SEGURANÇA: Funciona exclusivamente se o cliente pertencer ao ambiente = 'teste'.
   */
  public static generateMockXML(options: MockGenerationOptions): string {
    const { tenantId, tipoDoc, policyId, incluirVariaveisApolice, omitirObrigatorias } = options;
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

    const obsField = incluirVariaveisApolice
      ? this.buildObsField(policyId, omitirObrigatorias || [])
      : `Averbação de Teste ARCKATECH - Doc Nº ${docNum}`;

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
        <xObs>${obsField}</xObs>
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
        <infCpl>${obsField}</infCpl>
      </infAdic>
    </infNFe>
  </NFe>
</nfeProc>`;
    }

    if (tipoDoc === 'MDFE') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<mdfeProc xmlns="http://www.portalfiscal.inf.br/mdfe" versao="3.00">
  <MDFe>
    <infMDFe Id="MDFe${chave}" versao="3.00">
      <ide>
        <cUF>35</cUF>
        <nMDF>${docNum}</nMDF>
        <dhEmi>${dateISO}</dhEmi>
        <UFIni>SP</UFIni>
        <UFFim>MG</UFFim>
      </ide>
      <emit>
        <CNPJ>${tenant.cnpj.replace(/\D/g, '')}</CNPJ>
        <xNome>${tenant.razao_social}</xNome>
      </emit>
      <tot>
        <vCarga>${valorCarga}</vCarga>
      </tot>
      <infAdic>
        <infCpl>${obsField}</infCpl>
      </infAdic>
    </infMDFe>
  </MDFe>
</mdfeProc>`;
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
      <outrasInformacoes>${obsField}</outrasInformacoes>
    </infNfse>
  </Nfse>
</CompNfse>`;
  }
}
