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

      // CTe Parser
      if (parsedObj.CTe || parsedObj.cteProc) {
        tipoDocumento = 'CTE';
        const cteNode = parsedObj.CTe?.infCte || parsedObj.cteProc?.CTe?.infCte || {};
        chaveDocumento = cteNode['@_Id']?.replace('CTe', '') || chaveDocumento;
        numeroDocumento = String(cteNode.ide?.nCT || '0');
        valorCarga = Number(cteNode.vPrest?.vRec || cteNode.infCTeNorm?.infCarga?.vCarga || 0);

        // Achatar tags relevantes
        tagsMap['vCarga'] = valorCarga;
        tagsMap['nCT'] = numeroDocumento;
        tagsMap['dhEmi'] = cteNode.ide?.dhEmi;
        tagsMap['xObs'] = cteNode.compl?.xObs || '';
        tagsMap['infCpl'] = cteNode.compl?.ObsCont?.xTexto || '';
        tagsMap['TIPO_EMBALAGEM'] = cteNode.infCTeNorm?.infCarga?.proPred || tagsMap['xObs'];
      }
      // NFe Parser
      else if (parsedObj.NFe || parsedObj.nfeProc) {
        tipoDocumento = 'NFE';
        const nfeNode = parsedObj.NFe?.infNFe || parsedObj.nfeProc?.NFe?.infNFe || {};
        chaveDocumento = nfeNode['@_Id']?.replace('NFe', '') || chaveDocumento;
        numeroDocumento = String(nfeNode.ide?.nNF || '0');
        valorCarga = Number(nfeNode.total?.ICMSTot?.vProd || nfeNode.total?.ICMSTot?.vNF || 0);

        tagsMap['vProd'] = valorCarga;
        tagsMap['nNF'] = numeroDocumento;
        tagsMap['dhEmi'] = nfeNode.ide?.dhEmi;
        tagsMap['infCpl'] = nfeNode.infAdic?.infCpl || '';
      }
      // NFSe Parser
      else if (parsedObj.CompNfse || parsedObj.Nfse) {
        tipoDocumento = 'NFSE';
        const nfseNode = parsedObj.CompNfse?.Nfse?.infNfse || parsedObj.Nfse?.infNfse || {};
        numeroDocumento = String(nfseNode.numero || '0');
        valorCarga = Number(nfseNode.valores?.vServicos || 0);

        tagsMap['vServicos'] = valorCarga;
        tagsMap['numero'] = numeroDocumento;
      }

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
