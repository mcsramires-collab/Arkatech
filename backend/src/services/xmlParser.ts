import { XMLParser as FastXMLParser } from 'fast-xml-parser';
import { TipoDocumento } from '../types';

export interface ParsedDocumentData {
  tipoDocumento: TipoDocumento;
  chaveDocumento: string;
  numeroDocumento: string;
  valorCarga: number;
  tagsMap: Record<string, any>;
  rawXml: string;
  cnpjEmitente?: string;
  cnpjDestinatario?: string;
  cnpjRemetente?: string;
  cnpjExpedidor?: string;
  cnpjRecebedor?: string;
  cnpjTomador?: string;
  serie?: string; // série do documento (ide.serie no CT-e/NF-e/MDF-e)
  ufOrigem?: string;
  ufDestino?: string;
  produtoPredominante?: string;
  tpAmbSefaz?: 1 | 2; // 1=produção, 2=homologação
  protocoloAceitacaoSefaz?: string; // nProt do protXXX/infProt
}

export class XMLParserService {
  private static parser = new FastXMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Sem isso, o fast-xml-parser converte automaticamente qualquer tag cujo conteúdo
    // "pareça" numérico (ex.: <CNPJ>11111111000111</CNPJ>, <serie>01</serie>) para
    // Number — o que quebra CNPJs (perde zeros à esquerda / vira número em vez de
    // string) e derrubava o processo inteiro em services/averbacao.ts (norm() chama
    // .replace() esperando string). Os poucos campos que precisam ser número
    // (vCarga, tpAmb etc.) já são explicitamente convertidos com Number(...) abaixo.
    parseTagValue: false
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
   * Extrai variáveis dos grupos <obsCont>/<obsFisco> repetíveis (xCampo/xTexto), comuns
   * a CT-e e NF-e, complementando o que vier em texto livre no xObs/infCpl.
   */
  private static extractObsContVariables(obsCont: any): Record<string, string> {
    const result: Record<string, string> = {};
    if (!obsCont) return result;
    const items = Array.isArray(obsCont) ? obsCont : [obsCont];
    for (const item of items) {
      const campo = item?.['@_xCampo'];
      const texto = item?.xTexto;
      if (campo && texto !== undefined) result[campo] = String(texto);
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
          rawXml: trimmed,
          cnpjEmitente: json.cnpjEmitente,
          cnpjDestinatario: json.cnpjDestinatario,
          serie: json.serie !== undefined ? String(json.serie) : undefined,
          tpAmbSefaz: json.tpAmbSefaz,
          protocoloAceitacaoSefaz: json.protocoloAceitacaoSefaz
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
      let cnpjEmitente: string | undefined;
      let cnpjDestinatario: string | undefined;
      let cnpjRemetente: string | undefined;
      let cnpjExpedidor: string | undefined;
      let cnpjRecebedor: string | undefined;
      let cnpjTomador: string | undefined;
      let serie: string | undefined;
      let ufOrigem: string | undefined;
      let ufDestino: string | undefined;
      let produtoPredominante: string | undefined;
      let tpAmbSefaz: 1 | 2 | undefined;
      let protocoloAceitacaoSefaz: string | undefined;
      const tagsMap: Record<string, any> = {};
      let obsText = '';
      let obsContRaw: any;

      // CTe Parser (cteProc = CTe + protCTe)
      if (parsedObj.CTe || parsedObj.cteProc) {
        tipoDocumento = 'CTE';
        const cteNode = parsedObj.CTe?.infCte || parsedObj.cteProc?.CTe?.infCte || {};
        const protNode = parsedObj.cteProc?.protCTe?.infProt;
        chaveDocumento = cteNode['@_Id']?.replace('CTe', '') || protNode?.chCTe || chaveDocumento;
        numeroDocumento = String(cteNode.ide?.nCT || '0');
        valorCarga = Number(cteNode.vPrest?.vRec || cteNode.infCTeNorm?.infCarga?.vCarga || 0);
        cnpjEmitente = cteNode.emit?.CNPJ;
        cnpjDestinatario = cteNode.dest?.CNPJ;
        cnpjRemetente = cteNode.rem?.CNPJ;
        cnpjExpedidor = cteNode.exped?.CNPJ;
        cnpjRecebedor = cteNode.receb?.CNPJ;
        cnpjTomador = cteNode.toma?.CNPJ ?? cteNode.toma4?.CNPJ ?? cteNode.toma3?.CNPJ;
        serie = cteNode.ide?.serie !== undefined ? String(cteNode.ide.serie) : undefined;
        ufOrigem = cteNode.ide?.UFIni;
        ufDestino = cteNode.ide?.UFFim;
        produtoPredominante = cteNode.infCTeNorm?.infCarga?.proPred;
        tpAmbSefaz = cteNode.ide?.tpAmb ? Number(cteNode.ide.tpAmb) as 1 | 2 : undefined;
        protocoloAceitacaoSefaz = protNode?.nProt;

        tagsMap['vCarga'] = valorCarga;
        tagsMap['nCT'] = numeroDocumento;
        tagsMap['dhEmi'] = cteNode.ide?.dhEmi;
        tagsMap['CFOP'] = cteNode.ide?.CFOP;
        tagsMap['cUF'] = cteNode.ide?.cUF;
        obsText = cteNode.compl?.xObs || '';
        obsContRaw = cteNode.compl?.ObsCont || cteNode.compl?.obsCont;
        tagsMap['xObs'] = obsText;
      }
      // NFe Parser (nfeProc = NFe + protNFe)
      else if (parsedObj.NFe || parsedObj.nfeProc) {
        tipoDocumento = 'NFE';
        const nfeNode = parsedObj.NFe?.infNFe || parsedObj.nfeProc?.NFe?.infNFe || {};
        const protNode = parsedObj.nfeProc?.protNFe?.infProt;
        chaveDocumento = nfeNode['@_Id']?.replace('NFe', '') || protNode?.chNFe || chaveDocumento;
        numeroDocumento = String(nfeNode.ide?.nNF || '0');
        valorCarga = Number(nfeNode.total?.ICMSTot?.vProd || nfeNode.total?.ICMSTot?.vNF || 0);
        cnpjEmitente = nfeNode.emit?.CNPJ;
        cnpjDestinatario = nfeNode.dest?.CNPJ;
        serie = nfeNode.ide?.serie !== undefined ? String(nfeNode.ide.serie) : undefined;
        tpAmbSefaz = nfeNode.ide?.tpAmb ? Number(nfeNode.ide.tpAmb) as 1 | 2 : undefined;
        protocoloAceitacaoSefaz = protNode?.nProt;

        tagsMap['vProd'] = valorCarga;
        tagsMap['vNF'] = Number(nfeNode.total?.ICMSTot?.vNF || valorCarga);
        tagsMap['nNF'] = numeroDocumento;
        tagsMap['dhEmi'] = nfeNode.ide?.dhEmi;
        obsText = nfeNode.infAdic?.infCpl || '';
        obsContRaw = nfeNode.infAdic?.obsCont;
        tagsMap['infCpl'] = obsText;
      }
      // NFSe Parser (padrão ADN/DPS)
      else if (parsedObj.CompNfse || parsedObj.Nfse || parsedObj.DPS) {
        tipoDocumento = 'NFSE';
        const nfseNode = parsedObj.CompNfse?.Nfse?.infNfse || parsedObj.Nfse?.infNfse || {};
        const dpsNode = parsedObj.DPS?.infDPS || {};
        numeroDocumento = String(nfseNode.numero || dpsNode.nDPS || '0');
        valorCarga = Number(nfseNode.valores?.vServicos || dpsNode.serv?.vServPrest?.vReceb || 0);
        cnpjEmitente = nfseNode.prestador?.CNPJ || dpsNode.prest?.CNPJ;
        cnpjDestinatario = nfseNode.tomador?.CNPJ || dpsNode.toma?.CNPJ;
        tpAmbSefaz = (nfseNode.tpAmb || dpsNode.tpAmb) ? Number(nfseNode.tpAmb || dpsNode.tpAmb) as 1 | 2 : undefined;

        tagsMap['vServicos'] = valorCarga;
        tagsMap['numero'] = numeroDocumento;
        obsText = nfseNode.outrasInformacoes || dpsNode.xInfComp || '';
      }
      // MDFe Parser (mdfeProc = MDFe + protMDFe)
      else if (parsedObj.MDFe || parsedObj.mdfeProc) {
        tipoDocumento = 'MDFE';
        const mdfeNode = parsedObj.MDFe?.infMDFe || parsedObj.mdfeProc?.MDFe?.infMDFe || {};
        const protNode = parsedObj.mdfeProc?.protMDFe?.infProt;
        chaveDocumento = mdfeNode['@_Id']?.replace('MDFe', '') || protNode?.chMDFe || chaveDocumento;
        numeroDocumento = String(mdfeNode.ide?.nMDF || '0');
        valorCarga = Number(mdfeNode.tot?.vCarga || 0);
        cnpjEmitente = mdfeNode.emit?.CNPJ;
        serie = mdfeNode.ide?.serie !== undefined ? String(mdfeNode.ide.serie) : undefined;
        ufOrigem = mdfeNode.ide?.UFIni;
        ufDestino = mdfeNode.ide?.UFFim;
        tpAmbSefaz = mdfeNode.ide?.tpAmb ? Number(mdfeNode.ide.tpAmb) as 1 | 2 : undefined;
        protocoloAceitacaoSefaz = protNode?.nProt;

        tagsMap['nMDF'] = numeroDocumento;
        tagsMap['dhEmi'] = mdfeNode.ide?.dhEmi;
        tagsMap['vCarga'] = valorCarga;
        tagsMap['UFIni'] = mdfeNode.ide?.UFIni;
        tagsMap['UFFim'] = mdfeNode.ide?.UFFim;

        // Grupo <seg> — obrigatório no modal rodoviário (validado pelo Sefaz via rejeições 698/699)
        const segNode = mdfeNode.seg;
        if (segNode) {
          tagsMap['seg.nApol'] = segNode.nApol;
          tagsMap['seg.nAver'] = segNode.nAver;
          tagsMap['seg.infSeg.xSeg'] = segNode.infSeg?.xSeg;
          tagsMap['seg.infSeg.CNPJ'] = segNode.infSeg?.CNPJ;
          tagsMap['seg.infResp.respSeg'] = segNode.infResp?.respSeg;
        }

        obsText = mdfeNode.infAdic?.infCpl || '';
      }

      // Extrai variáveis de apólice embutidas no campo de observação (OBS) e no grupo obsCont
      const obsVars = this.extractObsVariables(obsText);
      const obsContVars = this.extractObsContVariables(obsContRaw);
      Object.assign(tagsMap, obsVars, obsContVars);

      return {
        tipoDocumento,
        chaveDocumento,
        numeroDocumento,
        valorCarga,
        tagsMap,
        rawXml: trimmed,
        cnpjEmitente,
        cnpjDestinatario,
        cnpjRemetente,
        cnpjExpedidor,
        cnpjRecebedor,
        cnpjTomador,
        serie,
        ufOrigem,
        ufDestino,
        produtoPredominante,
        tpAmbSefaz,
        protocoloAceitacaoSefaz
      };
    } catch (err: any) {
      throw new Error('Formato XML malformado ou desconhecido: ' + err.message);
    }
  }
}
