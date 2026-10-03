import { XMLParser as FastXMLParser } from 'fast-xml-parser';
import { TipoDocumento } from '../types';

export interface ParsedDocumentData {
  tipoDocumento: TipoDocumento;
  chaveDocumento: string;
  numeroDocumento: string;
  valorCarga: number;
  tagsMap: Record<string, any>;
  rawXml: string;
  /** Data canônica de emissão usada por vigência, matching e prazos. */
  dataEmissao?: string;
  cnpjEmitente?: string;
  cnpjDestinatario?: string;
  cnpjRemetente?: string;
  cnpjExpedidor?: string;
  cnpjRecebedor?: string;
  cnpjTomador?: string;
  cnpjTransportador?: string;
  /** NF-e: modalidade do frete em transp/modFrete. */
  modFrete?: string;
  /** NF-e: CNPJ/CPF autorizados a acessar o XML (grupo autXML). */
  autXmlIds?: string[];
  /** Chaves NF-e referenciadas pelo CT-e/MDF-e atual. */
  referencedNfeKeys?: string[];
  /** Chaves CT-e referenciadas pelo MDF-e atual. */
  referencedCteKeys?: string[];
  serie?: string;
  ufOrigem?: string;
  ufDestino?: string;
  produtoPredominante?: string;
  tpAmbSefaz?: 1 | 2;
  protocoloAceitacaoSefaz?: string;
  cStatAutorizacaoSefaz?: string;
}

export interface ParsedCancelamentoData {
  chaveDocumentoCancelado: string;
  tipoEvento: string;
  protocoloEvento?: string;
  justificativa?: string;
  dataEvento?: string;
}

export class XMLParserService {
  private static parser = new FastXMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false
  });

  private static asArray<T = any>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  }

  private static uniqueStrings(values: Array<unknown>): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => (value === undefined || value === null ? '' : String(value).trim()))
          .filter(Boolean)
      )
    );
  }

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

  private static extractCteReferencedNfeKeys(cteNode: any): string[] {
    const infDoc = cteNode?.infCTeNorm?.infDoc;
    return this.uniqueStrings(
      this.asArray(infDoc?.infNFe).flatMap((item: any) => [item?.chave, item?.chNFe])
    );
  }

  private static extractMdfeReferences(mdfeNode: any): {
    nfeKeys: string[];
    cteKeys: string[];
  } {
    const municipios = this.asArray(mdfeNode?.infDoc?.infMunDescarga);
    const nfeKeys: unknown[] = [];
    const cteKeys: unknown[] = [];

    for (const municipio of municipios as any[]) {
      for (const item of this.asArray(municipio?.infNFe) as any[]) {
        nfeKeys.push(item?.chNFe, item?.chave);
      }
      for (const item of this.asArray(municipio?.infCTe) as any[]) {
        cteKeys.push(item?.chCTe, item?.chave);
      }
    }

    return {
      nfeKeys: this.uniqueStrings(nfeKeys),
      cteKeys: this.uniqueStrings(cteKeys)
    };
  }

  public static parse(content: string): ParsedDocumentData {
    const trimmed = content.trim();

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
          dataEmissao:
            json.dataEmissao || json.data_emissao || json.dhEmi || json.dEmi || json.dataEmissaoDocumento,
          cnpjEmitente: json.cnpjEmitente,
          cnpjDestinatario: json.cnpjDestinatario,
          cnpjRemetente: json.cnpjRemetente,
          cnpjExpedidor: json.cnpjExpedidor,
          cnpjRecebedor: json.cnpjRecebedor,
          cnpjTomador: json.cnpjTomador,
          cnpjTransportador: json.cnpjTransportador,
          modFrete: json.modFrete !== undefined ? String(json.modFrete) : undefined,
          autXmlIds: this.uniqueStrings(json.autXmlIds || json.autXML || []),
          referencedNfeKeys: this.uniqueStrings(json.referencedNfeKeys || []),
          referencedCteKeys: this.uniqueStrings(json.referencedCteKeys || []),
          serie: json.serie !== undefined ? String(json.serie) : undefined,
          tpAmbSefaz: json.tpAmbSefaz,
          protocoloAceitacaoSefaz: json.protocoloAceitacaoSefaz,
          cStatAutorizacaoSefaz:
            json.cStatAutorizacaoSefaz !== undefined ? String(json.cStatAutorizacaoSefaz) : undefined
        };
      } catch (e) {
        throw new Error('Formato JSON inválido.');
      }
    }

    try {
      const parsedObj = this.parser.parse(trimmed);
      let tipoDocumento: TipoDocumento = 'CTE';
      let chaveDocumento = `CHAVE-SEFAZ-${Date.now()}`;
      let numeroDocumento = '0';
      let valorCarga = 0;
      let dataEmissao: string | undefined;
      let cnpjEmitente: string | undefined;
      let cnpjDestinatario: string | undefined;
      let cnpjRemetente: string | undefined;
      let cnpjExpedidor: string | undefined;
      let cnpjRecebedor: string | undefined;
      let cnpjTransportador: string | undefined;
      let cnpjTomador: string | undefined;
      let modFrete: string | undefined;
      let autXmlIds: string[] = [];
      let referencedNfeKeys: string[] = [];
      let referencedCteKeys: string[] = [];
      let serie: string | undefined;
      let ufOrigem: string | undefined;
      let ufDestino: string | undefined;
      let produtoPredominante: string | undefined;
      let tpAmbSefaz: 1 | 2 | undefined;
      let protocoloAceitacaoSefaz: string | undefined;
      let cStatAutorizacaoSefaz: string | undefined;
      let recognizedDocument = false;
      const tagsMap: Record<string, any> = {};
      let obsText = '';
      let obsContRaw: any;

      if (parsedObj.CTe || parsedObj.cteProc) {
        recognizedDocument = true;
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
        dataEmissao = cteNode.ide?.dhEmi;
        serie = cteNode.ide?.serie !== undefined ? String(cteNode.ide.serie) : undefined;
        ufOrigem = cteNode.ide?.UFIni;
        ufDestino = cteNode.ide?.UFFim;
        produtoPredominante = cteNode.infCTeNorm?.infCarga?.proPred;
        tpAmbSefaz = cteNode.ide?.tpAmb ? Number(cteNode.ide.tpAmb) as 1 | 2 : undefined;
        protocoloAceitacaoSefaz = protNode?.nProt;
        cStatAutorizacaoSefaz = protNode?.cStat !== undefined ? String(protNode.cStat) : undefined;
        referencedNfeKeys = this.extractCteReferencedNfeKeys(cteNode);

        tagsMap['vCarga'] = valorCarga;
        tagsMap['nCT'] = numeroDocumento;
        tagsMap['dhEmi'] = dataEmissao;
        tagsMap['dhRecBto'] = protNode?.dhRecbto;
        tagsMap['CFOP'] = cteNode.ide?.CFOP;
        tagsMap['cUF'] = cteNode.ide?.cUF;
        tagsMap['referencedNfeKeys'] = referencedNfeKeys;
        obsText = cteNode.compl?.xObs || '';
        obsContRaw = cteNode.compl?.ObsCont || cteNode.compl?.obsCont;
        tagsMap['xObs'] = obsText;
      } else if (parsedObj.NFe || parsedObj.nfeProc) {
        recognizedDocument = true;
        tipoDocumento = 'NFE';
        const nfeNode = parsedObj.NFe?.infNFe || parsedObj.nfeProc?.NFe?.infNFe || {};
        const protNode = parsedObj.nfeProc?.protNFe?.infProt;
        chaveDocumento = nfeNode['@_Id']?.replace('NFe', '') || protNode?.chNFe || chaveDocumento;
        numeroDocumento = String(nfeNode.ide?.nNF || '0');
        valorCarga = Number(nfeNode.total?.ICMSTot?.vProd || nfeNode.total?.ICMSTot?.vNF || 0);
        cnpjEmitente = nfeNode.emit?.CNPJ;
        cnpjDestinatario = nfeNode.dest?.CNPJ;
        cnpjTransportador = nfeNode.transp?.transporta?.CNPJ;
        modFrete = nfeNode.transp?.modFrete !== undefined ? String(nfeNode.transp.modFrete) : undefined;
        autXmlIds = this.uniqueStrings(
          this.asArray(nfeNode.autXML).flatMap((item: any) => [item?.CNPJ, item?.CPF])
        );
        dataEmissao = nfeNode.ide?.dhEmi || nfeNode.ide?.dEmi;
        serie = nfeNode.ide?.serie !== undefined ? String(nfeNode.ide.serie) : undefined;
        tpAmbSefaz = nfeNode.ide?.tpAmb ? Number(nfeNode.ide.tpAmb) as 1 | 2 : undefined;
        protocoloAceitacaoSefaz = protNode?.nProt;
        cStatAutorizacaoSefaz = protNode?.cStat !== undefined ? String(protNode.cStat) : undefined;

        tagsMap['vProd'] = valorCarga;
        tagsMap['vNF'] = Number(nfeNode.total?.ICMSTot?.vNF || valorCarga);
        tagsMap['nNF'] = numeroDocumento;
        tagsMap['dhEmi'] = dataEmissao;
        tagsMap['dhRecBto'] = protNode?.dhRecbto;
        tagsMap['modFrete'] = modFrete;
        tagsMap['autXML'] = autXmlIds;
        obsText = nfeNode.infAdic?.infCpl || '';
        obsContRaw = nfeNode.infAdic?.obsCont;
        tagsMap['infCpl'] = obsText;
      } else if (parsedObj.CompNfse || parsedObj.Nfse || parsedObj.DPS) {
        recognizedDocument = true;
        tipoDocumento = 'NFSE';
        const nfseNode = parsedObj.CompNfse?.Nfse?.infNfse || parsedObj.Nfse?.infNfse || {};
        const dpsNode = parsedObj.DPS?.infDPS || {};
        numeroDocumento = String(nfseNode.numero || dpsNode.nDPS || '0');
        valorCarga = Number(nfseNode.valores?.vServicos || dpsNode.serv?.vServPrest?.vReceb || 0);
        cnpjEmitente = nfseNode.prestador?.CNPJ || dpsNode.prest?.CNPJ;
        cnpjDestinatario = nfseNode.tomador?.CNPJ || dpsNode.toma?.CNPJ;
        dataEmissao = nfseNode.dhEmi || nfseNode.dataEmissao || dpsNode.dhEmi;
        tpAmbSefaz = (nfseNode.tpAmb || dpsNode.tpAmb) ? Number(nfseNode.tpAmb || dpsNode.tpAmb) as 1 | 2 : undefined;

        tagsMap['vServicos'] = valorCarga;
        tagsMap['numero'] = numeroDocumento;
        tagsMap['dhEmi'] = dataEmissao;
        obsText = nfseNode.outrasInformacoes || dpsNode.xInfComp || '';
      } else if (parsedObj.MDFe || parsedObj.mdfeProc) {
        recognizedDocument = true;
        tipoDocumento = 'MDFE';
        const mdfeNode = parsedObj.MDFe?.infMDFe || parsedObj.mdfeProc?.MDFe?.infMDFe || {};
        const protNode = parsedObj.mdfeProc?.protMDFe?.infProt;
        chaveDocumento = mdfeNode['@_Id']?.replace('MDFe', '') || protNode?.chMDFe || chaveDocumento;
        numeroDocumento = String(mdfeNode.ide?.nMDF || '0');
        valorCarga = Number(mdfeNode.tot?.vCarga || 0);
        cnpjEmitente = mdfeNode.emit?.CNPJ;
        dataEmissao = mdfeNode.ide?.dhEmi;
        serie = mdfeNode.ide?.serie !== undefined ? String(mdfeNode.ide.serie) : undefined;
        ufOrigem = mdfeNode.ide?.UFIni;
        ufDestino = mdfeNode.ide?.UFFim;
        tpAmbSefaz = mdfeNode.ide?.tpAmb ? Number(mdfeNode.ide.tpAmb) as 1 | 2 : undefined;
        protocoloAceitacaoSefaz = protNode?.nProt;
        cStatAutorizacaoSefaz = protNode?.cStat !== undefined ? String(protNode.cStat) : undefined;
        const references = this.extractMdfeReferences(mdfeNode);
        referencedNfeKeys = references.nfeKeys;
        referencedCteKeys = references.cteKeys;

        tagsMap['nMDF'] = numeroDocumento;
        tagsMap['dhEmi'] = dataEmissao;
        tagsMap['dhRecBto'] = protNode?.dhRecbto;
        tagsMap['vCarga'] = valorCarga;
        tagsMap['UFIni'] = mdfeNode.ide?.UFIni;
        tagsMap['UFFim'] = mdfeNode.ide?.UFFim;
        tagsMap['referencedNfeKeys'] = referencedNfeKeys;
        tagsMap['referencedCteKeys'] = referencedCteKeys;

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

      if (!recognizedDocument) {
        throw new Error('Documento fiscal não reconhecido.');
      }

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
        dataEmissao,
        cnpjEmitente,
        cnpjDestinatario,
        cnpjRemetente,
        cnpjExpedidor,
        cnpjRecebedor,
        cnpjTransportador,
        cnpjTomador,
        modFrete,
        autXmlIds,
        referencedNfeKeys,
        referencedCteKeys,
        serie,
        ufOrigem,
        ufDestino,
        produtoPredominante,
        tpAmbSefaz,
        protocoloAceitacaoSefaz,
        cStatAutorizacaoSefaz
      };
    } catch (err: any) {
      throw new Error('Formato XML malformado ou desconhecido: ' + err.message);
    }
  }

  public static parseEventoCancelamento(content: string): ParsedCancelamentoData {
    const trimmed = content.trim();
    try {
      const parsedObj = this.parser.parse(trimmed);
      const procEvento =
        parsedObj.procEventoCTe || parsedObj.procEventoNFe || parsedObj.procEventoMDFe || parsedObj;
      const eventoNode = procEvento.evento || procEvento.eventoCTe || procEvento.eventoNFe || procEvento.eventoMDFe;
      const infEvento = eventoNode?.infEvento;

      if (!infEvento) {
        throw new Error('Evento de cancelamento sem o nó infEvento — XML não é um evento Sefaz válido.');
      }

      const tipoEvento = String(infEvento.tpEvento ?? '');
      const chaveDocumentoCancelado: string | undefined =
        infEvento.chCTe || infEvento.chNFe || infEvento.chMDFe || infEvento['@_chDoc'];
      const detEvento = infEvento.detEvento;
      const detEspecifico =
        detEvento?.evCancCTe || detEvento?.evCancNFe || detEvento?.evCancMDFe || detEvento;
      const justificativa: string | undefined = detEspecifico?.xJust;
      const retEventoNode = procEvento.retEvento || procEvento.retEventoCTe || procEvento.retEventoNFe || procEvento.retEventoMDFe;
      const protocoloEvento: string | undefined =
        retEventoNode?.infEvento?.nProt || detEspecifico?.nProt || detEspecifico?.nProtCTe;
      const dataEvento: string | undefined = infEvento.dhEvento;

      if (!chaveDocumentoCancelado) {
        throw new Error('Evento de cancelamento sem a chave do documento cancelado (chCTe/chNFe/chMDFe).');
      }

      return { chaveDocumentoCancelado, tipoEvento, protocoloEvento, justificativa, dataEvento };
    } catch (err: any) {
      throw new Error('Formato do evento de cancelamento inválido ou malformado: ' + err.message);
    }
  }
}
