import { XMLParser as FastXMLParser } from 'fast-xml-parser';
import { TipoDocumento } from '../types';

export interface ParsedDocumentData {
  tipoDocumento: TipoDocumento;
  chaveDocumento: string;
  numeroDocumento: string;
  valorCarga: number;
  tagsMap: Record<string, any>;
  rawXml: string;
}

export class XMLParserService {
  private static parser = new FastXMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });

  /**
   * Extrai variáveis embutidas em um campo de observação livre (xObs / infCpl / xObsMDFe)
   * no formato "NOME_VARIAVEL=valor; OUTRA_VARIAVEL=valor". É assim que o sistema lê,
   * dentro de um campo texto do documento fiscal, o preenchimento de variáveis de apólice
   * que não têm uma tag XML própria no padrão Sefaz.
   */
  private static extractObsVariables(obsText: string | undefined | null): Record<string, string> {
    const result: Record<string, string> = {};
    if (!obsText) return result;

    const parts = String(obsText).split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  }

  /**
   * Realiza a leitura e extração de dados do XML ou JSON do documento Fiscal.
   */
  public static parse(content: string): ParsedDocumentData {
    const trimmed = content.trim();

    // 1. Se for um JSON direto
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        return {
          tipoDocumento: json.tipoDocumento || 'CTE',
          chaveDocumento: json.chaveDocumento || json.chave || `CHAVE-MOCK-${Date.now()}`,
          numeroDocumento: json.numeroDocumento || json.nCT || json.nNF || '12345',
          valorCarga: Number(json.valorCarga || json.vCarga || json.vProd || 1000.0),
          tagsMap: json,
          rawXml: trimmed
        };
      } catch (e) {
        throw new Error('Formato JSON inválido.');
      }
    }

    // 2. Se for um XML Sefaz
    try {
      const parsedObj = this.parser.parse(trimmed);
      let tipoDocumento: TipoDocumento = 'CTE';
      let chaveDocumento = `CHAVE-SEFAZ-${Date.now()}`;
      let numeroDocumento = '0';
      let valorCarga = 0;
      const tagsMap: Record<string, any> = {};
      let obsText = '';

      // CTe Parser
      if (parsedObj.CTe || parsedObj.cteProc) {
        tipoDocumento = 'CTE';
        const cteNode = parsedObj.CTe?.infCte || parsedObj.cteProc?.CTe?.infCte || {};
        chaveDocumento = cteNode['@_Id']?.replace('CTe', '') || chaveDocumento;
        numeroDocumento = String(cteNode.ide?.nCT || '0');
        valorCarga = Number(cteNode.vPrest?.vRec || cteNode.infCTeNorm?.infCarga?.vCarga || 0);

        tagsMap['vCarga'] = valorCarga;
        tagsMap['nCT'] = numeroDocumento;
        tagsMap['dhEmi'] = cteNode.ide?.dhEmi;
        tagsMap['CFOP'] = cteNode.ide?.CFOP;
        tagsMap['cUF'] = cteNode.ide?.cUF;
        obsText = cteNode.compl?.xObs || cteNode.compl?.ObsCont?.xTexto || '';
        tagsMap['xObs'] = obsText;
        tagsMap['infCpl'] = cteNode.compl?.ObsCont?.xTexto || '';
      }
      // NFe Parser
      else if (parsedObj.NFe || parsedObj.nfeProc) {
        tipoDocumento = 'NFE';
        const nfeNode = parsedObj.NFe?.infNFe || parsedObj.nfeProc?.NFe?.infNFe || {};
        chaveDocumento = nfeNode['@_Id']?.replace('NFe', '') || chaveDocumento;
        numeroDocumento = String(nfeNode.ide?.nNF || '0');
        valorCarga = Number(nfeNode.total?.ICMSTot?.vProd || nfeNode.total?.ICMSTot?.vNF || 0);

        tagsMap['vProd'] = valorCarga;
        tagsMap['vNF'] = Number(nfeNode.total?.ICMSTot?.vNF || valorCarga);
        tagsMap['nNF'] = numeroDocumento;
        tagsMap['dhEmi'] = nfeNode.ide?.dhEmi;
        obsText = nfeNode.infAdic?.infCpl || '';
        tagsMap['infCpl'] = obsText;
      }
      // NFSe Parser
      else if (parsedObj.CompNfse || parsedObj.Nfse) {
        tipoDocumento = 'NFSE';
        const nfseNode = parsedObj.CompNfse?.Nfse?.infNfse || parsedObj.Nfse?.infNfse || {};
        numeroDocumento = String(nfseNode.numero || '0');
        valorCarga = Number(nfseNode.valores?.vServicos || 0);

        tagsMap['vServicos'] = valorCarga;
        tagsMap['numero'] = numeroDocumento;
        obsText = nfseNode.outrasInformacoes || '';
      }
      // MDFe Parser
      else if (parsedObj.MDFe || parsedObj.mdfeProc) {
        tipoDocumento = 'MDFE';
        const mdfeNode = parsedObj.MDFe?.infMDFe || parsedObj.mdfeProc?.MDFe?.infMDFe || {};
        chaveDocumento = mdfeNode['@_Id']?.replace('MDFe', '') || chaveDocumento;
        numeroDocumento = String(mdfeNode.ide?.nMDF || '0');
        valorCarga = Number(mdfeNode.tot?.vCarga || 0);

        tagsMap['nMDF'] = numeroDocumento;
        tagsMap['dhEmi'] = mdfeNode.ide?.dhEmi;
        tagsMap['vCarga'] = valorCarga;
        tagsMap['UFIni'] = mdfeNode.ide?.UFIni;
        tagsMap['UFFim'] = mdfeNode.ide?.UFFim;
        obsText = mdfeNode.infAdic?.infCpl || '';
        tagsMap['infCpl'] = obsText;
      }

      // Extrai variáveis de apólice embutidas no campo de observação (OBS)
      const obsVars = this.extractObsVariables(obsText);
      Object.assign(tagsMap, obsVars);

      return {
        tipoDocumento,
        chaveDocumento,
        numeroDocumento,
        valorCarga,
        tagsMap,
        rawXml: trimmed
      };
    } catch (err: any) {
      throw new Error('Formato XML malformado ou desconhecido: ' + err.message);
    }
  }
}
