import { dbStore } from './dbStore';
import { TipoDocumento, FuncaoDocumento } from '../types';

export interface MockGenerationOptions {
  tenantId: string;
  tipoDoc: TipoDocumento;
  policyId?: string;
  incluirVariaveisApolice?: boolean;
  omitirObrigatorias?: string[]; // nomes de variáveis a propositalmente OMITIR (para testar recusa)
  comoDestinatario?: boolean; // atalho legado — equivale a funcaoTenant='DESTINATARIO'
  funcaoTenant?: FuncaoDocumento; // em qual função do documento o CNPJ do tenant aparece (default EMISSOR)
  omitirCnpjTenant?: boolean; // gera o documento SEM o CNPJ do tenant em nenhuma função — testa a Regra B (bypass)
  ufOrigem?: string; // usado junto com omitirCnpjTenant para testar bypass por rota
  ufDestino?: string;
  tpAmbSefaz?: 1 | 2; // 1=produção (default), 2=homologação — testa a regra do "protocolo TESTE"
  omitirGrupoSeguro?: boolean; // MDF-e apenas: gera sem o grupo <seg>, para testar a rejeição 699 do Sefaz
}

export class MockGeneratorService {
  /**
   * Monta a string do campo de observação (xObs/infCpl) embutindo as variáveis
   * de apólice no formato "NOME=valor; NOME2=valor2", que o xmlParser sabe ler de volta.
   */
  private static buildObsField(policyId: string | undefined, omitir: string[] = []): string {
    if (!policyId) return '';
    const policy = dbStore.policies.find((p) => p.id === policyId);
    if (!policy) return '';
    const coverages = dbStore.insurerCoverages.filter(
      (c) =>
        c.insurer_id === policy.insurer_id &&
        (!c.ramo || c.ramo === policy.ramo) &&
        (c.aplicar_todos_clientes || c.tenant_id === policy.tenant_id)
    );
    const pairs = coverages
      .filter((c) => !omitir.includes(c.titulo))
      .map((c) => `${c.titulo}=${c.exemplo_preenchimento || 'VALOR_EXEMPLO'}`);
    return pairs.join('; ');
  }

  private static randomChave(cnpj: string, docNum: number, cUF = '35', mod = '57'): string {
    const cnpjLimpo = cnpj.replace(/\D/g, '').padStart(14, '0');
    const aamm = '2603';
    const serie = '001';
    const nDoc = String(docNum).padStart(9, '0');
    const tpEmis = '1';
    const cNF = String(docNum).padStart(8, '0');
    const semDV = `${cUF}${aamm}${cnpjLimpo}${mod}${serie}${nDoc}${tpEmis}${cNF}`;
    return (semDV + '0').slice(0, 44).padEnd(44, '0');
  }

  /**
   * Gera um documento XML Sefaz fictício, estruturalmente completo (grupos de emitente,
   * destinatário, protocolo de autorização etc.), com base no cadastro do transportador (tenant)
   * e, opcionalmente, da apólice usada. TRAVA DE SEGURANÇA: só funciona se o tenant pertencer
   * ao ambiente = 'teste'.
   */
  public static generateMockXML(options: MockGenerationOptions): string {
    const {
      tenantId,
      tipoDoc,
      policyId,
      incluirVariaveisApolice,
      omitirObrigatorias,
      comoDestinatario,
      funcaoTenant,
      omitirCnpjTenant,
      ufOrigem,
      ufDestino,
      tpAmbSefaz = 1,
      omitirGrupoSeguro
    } = options;
    const tenant = dbStore.tenants.find((t) => t.id === tenantId);

    if (!tenant) {
      throw new Error('Cliente não encontrado.');
    }

    if (tenant.ambiente !== 'teste') {
      throw new Error(
        'ALERTA DE SEGURANÇA: A geração de dados fictícios (MOCK) é estritamente proibida em clientes do ambiente de PRODUÇÃO.'
      );
    }

    const policy = policyId ? dbStore.policies.find((p) => p.id === policyId) : undefined;
    const insurer = policy ? dbStore.insurers.find((i) => i.id === policy.insurer_id) : undefined;

    const docNum = Math.floor(100000 + Math.random() * 900000);
    const valorCarga = (Math.random() * 50000 + 1000).toFixed(2);
    const dateISO = new Date().toISOString().slice(0, 19) + '-03:00';
    const nProt = `1352${Date.now().toString().slice(-11)}`;

    // Contraparte fictícia (usada em toda função do documento onde o tenant NÃO está)
    const contraparteCNPJ = '98765432000188';
    const contraparteNome = 'INDUSTRIAS REUNIDAS TESTE SA';
    const tenantCNPJ = tenant.cnpj.replace(/\D/g, '');

    // Função efetiva do tenant no documento (comoDestinatario é atalho legado)
    const funcao = omitirCnpjTenant ? undefined : comoDestinatario ? 'DESTINATARIO' : funcaoTenant || 'EMISSOR';

    const cnpjPara = (papel: string) => (funcao === papel ? tenantCNPJ : contraparteCNPJ);
    const nomePara = (papel: string) => (funcao === papel ? tenant.razao_social : contraparteNome);

    // Emitente sempre precisa existir; se o tenant não está em nenhuma função (bypass), o emitente é a contraparte.
    const emitCNPJ = omitirCnpjTenant ? contraparteCNPJ : funcao === 'EMISSOR' ? tenantCNPJ : contraparteCNPJ;
    const emitNome = omitirCnpjTenant ? contraparteNome : funcao === 'EMISSOR' ? tenant.razao_social : contraparteNome;
    const destCNPJ = omitirCnpjTenant ? contraparteCNPJ : cnpjPara('DESTINATARIO');
    const destNome = omitirCnpjTenant ? contraparteNome : nomePara('DESTINATARIO');
    const remCNPJ = omitirCnpjTenant ? contraparteCNPJ : cnpjPara('REMETENTE');
    const tomaCNPJ = omitirCnpjTenant ? contraparteCNPJ : cnpjPara('TOMADOR');
    const expedCNPJ = omitirCnpjTenant ? contraparteCNPJ : cnpjPara('EXPEDIDOR');
    const recebCNPJ = omitirCnpjTenant ? contraparteCNPJ : cnpjPara('RECEBEDOR');

    const chave = this.randomChave(emitCNPJ, docNum, '35', tipoDoc === 'NFE' ? '55' : tipoDoc === 'MDFE' ? '58' : '57');
    const ufIniFinal = ufOrigem || 'SP';
    const ufFimFinal = ufDestino || 'MG';

    const obsField = incluirVariaveisApolice
      ? this.buildObsField(policyId, omitirObrigatorias || [])
      : `Averbação de Teste ARCKATECH - Doc Nº ${docNum}`;

    // Grupo <seg> do MDF-e — obrigatório no modal rodoviário (rejeições 698/699 do Sefaz se ausente/incompleto)
    const grupoSeg =
      tipoDoc === 'MDFE' && !omitirGrupoSeguro
        ? `      <seg>
        <infResp>
          <respSeg>1</respSeg>
          <CNPJ>${emitCNPJ}</CNPJ>
        </infResp>
        <infSeg>
          <xSeg>${insurer?.nome_fantasia || insurer?.nome || 'SEGURADORA DE TESTE'}</xSeg>
          <CNPJ>${insurer?.cnpj.replace(/\D/g, '') || '33444555000166'}</CNPJ>
        </infSeg>
        <nApol>${policy?.numero_apolice || 'APOLICE-TESTE'}</nApol>
        <nAver>ARCK${docNum}${Date.now().toString().slice(-6)}</nAver>
      </seg>
`
        : '';

    if (tipoDoc === 'CTE') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<cteProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/cte">
  <CTe xmlns="http://www.portalfiscal.inf.br/cte">
    <infCte versao="4.00" Id="CTe${chave}">
      <ide>
        <cUF>35</cUF>
        <cCT>${String(docNum).padStart(8, '0')}</cCT>
        <CFOP>5353</CFOP>
        <natOp>PRESTACAO DE SERVICO DE TRANSPORTE</natOp>
        <mod>57</mod>
        <serie>1</serie>
        <nCT>${docNum}</nCT>
        <dhEmi>${dateISO}</dhEmi>
        <tpAmb>${tpAmbSefaz}</tpAmb>
        <tpEmis>1</tpEmis>
        <UFIni>${ufIniFinal}</UFIni>
        <UFFim>${ufFimFinal}</UFFim>
        <toma3>
          <toma>0</toma>
        </toma3>
      </ide>
      <emit>
        <CNPJ>${emitCNPJ}</CNPJ>
        <xNome>${emitNome}</xNome>
      </emit>
      <rem>
        <CNPJ>${remCNPJ}</CNPJ>
      </rem>
      <dest>
        <CNPJ>${destCNPJ}</CNPJ>
        <xNome>${destNome}</xNome>
      </dest>
      <exped>
        <CNPJ>${expedCNPJ}</CNPJ>
      </exped>
      <receb>
        <CNPJ>${recebCNPJ}</CNPJ>
      </receb>
      <toma>
        <CNPJ>${tomaCNPJ}</CNPJ>
      </toma>
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
  <protCTe versao="4.00">
    <infProt>
      <tpAmb>${tpAmbSefaz}</tpAmb>
      <chCTe>${chave}</chCTe>
      <dhRecbto>${dateISO}</dhRecbto>
      <nProt>${nProt}</nProt>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso do CT-e</xMotivo>
    </infProt>
  </protCTe>
</cteProc>`;
    }

    if (tipoDoc === 'NFE') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe versao="4.00" Id="NFe${chave}">
      <ide>
        <cUF>35</cUF>
        <nNF>${docNum}</nNF>
        <dhEmi>${dateISO}</dhEmi>
        <tpAmb>${tpAmbSefaz}</tpAmb>
      </ide>
      <emit>
        <CNPJ>${emitCNPJ}</CNPJ>
        <xNome>${emitNome}</xNome>
      </emit>
      <dest>
        <CNPJ>${destCNPJ}</CNPJ>
        <xNome>${destNome}</xNome>
      </dest>
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
  <protNFe versao="4.00">
    <infProt>
      <tpAmb>${tpAmbSefaz}</tpAmb>
      <chNFe>${chave}</chNFe>
      <dhRecbto>${dateISO}</dhRecbto>
      <nProt>${nProt}</nProt>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</nfeProc>`;
    }

    if (tipoDoc === 'MDFE') {
      return `<?xml version="1.0" encoding="UTF-8"?>
<mdfeProc versao="3.00" xmlns="http://www.portalfiscal.inf.br/mdfe">
  <MDFe xmlns="http://www.portalfiscal.inf.br/mdfe">
    <infMDFe versao="3.00" Id="MDFe${chave}">
      <ide>
        <cUF>35</cUF>
        <tpAmb>${tpAmbSefaz}</tpAmb>
        <nMDF>${docNum}</nMDF>
        <dhEmi>${dateISO}</dhEmi>
        <UFIni>${ufIniFinal}</UFIni>
        <UFFim>${ufFimFinal}</UFFim>
      </ide>
      <emit>
        <CNPJ>${emitCNPJ}</CNPJ>
        <xNome>${emitNome}</xNome>
      </emit>
${grupoSeg}      <tot>
        <vCarga>${valorCarga}</vCarga>
      </tot>
      <infAdic>
        <infCpl>${obsField}</infCpl>
      </infAdic>
    </infMDFe>
  </MDFe>
  <protMDFe versao="3.00">
    <infProt>
      <tpAmb>${tpAmbSefaz}</tpAmb>
      <chMDFe>${chave}</chMDFe>
      <dhRecbto>${dateISO}</dhRecbto>
      <nProt>${nProt}</nProt>
      <cStat>100</cStat>
      <xMotivo>Autorizado o uso do MDF-e</xMotivo>
    </infProt>
  </protMDFe>
</mdfeProc>`;
    }

    // NFSe Fallback (padrão ADN/DPS simplificado)
    return `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.portalfiscal.inf.br/nfse">
  <Nfse>
    <infNfse>
      <numero>${docNum}</numero>
      <prestador>
        <CNPJ>${emitCNPJ}</CNPJ>
      </prestador>
      <tomador>
        <CNPJ>${destCNPJ}</CNPJ>
      </tomador>
      <valores>
        <vServicos>${valorCarga}</vServicos>
      </valores>
      <outrasInformacoes>${obsField}</outrasInformacoes>
    </infNfse>
  </Nfse>
</CompNfse>`;
  }
}
