import ExcelJS from '@protobi/exceljs';
import { PDFParse } from 'pdf-parse';
import { TipoDocumento } from '../../types';
import { normalizeAlphanumeric, normalizeCnpj } from '../../utils/cnpj';

export type UploadFormat = 'XML' | 'CSV' | 'XLSX' | 'PDF' | 'TXT';

export interface ParsedUploadDocument {
  filename: string;
  format: UploadFormat;
  content: string;
  row_number?: number;
  warnings: string[];
}

type Row = Record<string, unknown>;

const HEADER_ALIASES: Record<string, string[]> = {
  xml: ['xml', 'xml_content', 'conteudo_xml'],
  tipoDocumento: ['tipo_documento', 'tipo', 'documento', 'tipo_doc'],
  chaveDocumento: ['chave_documento', 'chave', 'chave_acesso', 'chave_de_acesso'],
  numeroDocumento: ['numero_documento', 'numero', 'nct', 'nnf', 'nmdf', 'ndps'],
  serie: ['serie', 'serie_documento'],
  valorCarga: ['valor_carga', 'valor', 'valor_documento', 'valor_total', 'vcarga', 'vprod', 'vnf'],
  cnpjEmitente: ['cnpj_emitente', 'emitente', 'cnpj_emissor', 'emissor'],
  cnpjRemetente: ['cnpj_remetente', 'remetente'],
  cnpjDestinatario: ['cnpj_destinatario', 'destinatario'],
  cnpjTomador: ['cnpj_tomador', 'tomador'],
  cnpjTransportador: ['cnpj_transportador', 'transportador'],
  protocoloAceitacaoSefaz: ['protocolo_aceitacao_sefaz', 'protocolo_sefaz', 'protocolo', 'nprot'],
  cStatAutorizacaoSefaz: ['cstat', 'cstat_autorizacao', 'status_sefaz'],
  tpAmbSefaz: ['tpamb', 'tp_amb', 'ambiente_sefaz']
};

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function findValue(row: Row, canonical: keyof typeof HEADER_ALIASES): unknown {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), value])
  );
  for (const alias of HEADER_ALIASES[canonical]) {
    if (normalized.has(alias)) return normalized.get(alias);
  }
  return undefined;
}

function cleanNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  const normalized =
    raw.includes(',') && raw.includes('.')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(',', '.').replace(/[^0-9.-]/g, '');

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTipo(value: unknown): TipoDocumento | undefined {
  const raw = normalizeAlphanumeric(value);
  if (raw === 'CTE') return 'CTE';
  if (raw === 'NFE') return 'NFE';
  if (raw === 'MDFE') return 'MDFE';
  if (raw === 'NFSE' || raw === 'NFS') return 'NFSE';
  return undefined;
}

function buildCanonicalContent(row: Row): { content?: string; warnings: string[] } {
  const warnings: string[] = [];
  const embeddedXml = String(findValue(row, 'xml') ?? '').trim();
  if (embeddedXml.startsWith('<')) {
    return { content: embeddedXml, warnings };
  }

  const tipoDocumento = normalizeTipo(findValue(row, 'tipoDocumento'));
  const chaveDocumento = normalizeAlphanumeric(findValue(row, 'chaveDocumento'));
  const numeroDocumento = String(findValue(row, 'numeroDocumento') ?? '').trim();
  const valorCarga = cleanNumber(findValue(row, 'valorCarga'));

  if (!tipoDocumento) warnings.push('tipo_documento ausente ou não reconhecido');
  if (!chaveDocumento && !numeroDocumento) warnings.push('chave_documento/numero_documento ausente');
  if (!(valorCarga > 0)) warnings.push('valor_carga ausente ou inválido');

  if (!tipoDocumento || (!chaveDocumento && !numeroDocumento) || !(valorCarga > 0)) {
    return { warnings };
  }

  const cnpj = (canonical: keyof typeof HEADER_ALIASES) => {
    const value = findValue(row, canonical);
    const normalized = normalizeCnpj(value);
    return normalized || undefined;
  };

  const protocolo = String(findValue(row, 'protocoloAceitacaoSefaz') ?? '').trim() || undefined;
  const cstat = String(findValue(row, 'cStatAutorizacaoSefaz') ?? '').trim() || undefined;
  const tpAmbRaw = Number(findValue(row, 'tpAmbSefaz'));
  const tpAmbSefaz = tpAmbRaw === 1 || tpAmbRaw === 2 ? tpAmbRaw : undefined;

  return {
    warnings,
    content: JSON.stringify({
      tipoDocumento,
      chaveDocumento: chaveDocumento || `${tipoDocumento}-${numeroDocumento}`,
      numeroDocumento: numeroDocumento || chaveDocumento.slice(-9),
      valorCarga,
      serie: String(findValue(row, 'serie') ?? '').trim() || undefined,
      cnpjEmitente: cnpj('cnpjEmitente'),
      cnpjRemetente: cnpj('cnpjRemetente'),
      cnpjDestinatario: cnpj('cnpjDestinatario'),
      cnpjTomador: cnpj('cnpjTomador'),
      cnpjTransportador: cnpj('cnpjTransportador'),
      protocoloAceitacaoSefaz: protocolo,
      cStatAutorizacaoSefaz: cstat,
      tpAmbSefaz
    })
  };
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function detectDelimiter(firstLine: string): string {
  const candidates = [';', '\t', '|', ','];
  return candidates
    .map((delimiter) => ({
      delimiter,
      count: splitDelimitedLine(firstLine, delimiter).length
    }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ';';
}

function delimitedRows(text: string): Row[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) return [];
  const delimiter = detectDelimiter(lines[0]!);
  const headers = splitDelimitedLine(lines[0]!, delimiter);

  return lines.slice(1).map((line) => {
    const values = splitDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function keyValueRow(text: string): Row {
  const row: Row = {};
  const patterns: Array<[string, RegExp]> = [
    ['tipo_documento', /(?:tipo(?:\s+de)?\s+documento|documento)\s*[:=-]\s*(CT-?E|NF-?E|MDF-?E|NFS-?E)/i],
    ['chave_documento', /(?:chave(?:\s+de)?\s+acesso|chave)\s*[:=-]\s*([A-Z0-9]{30,60})/i],
    ['numero_documento', /(?:n[uú]mero|n[º°]|nCT|nNF|nMDF)\s*[:=-]\s*([A-Z0-9./-]+)/i],
    ['serie', /s[eé]rie\s*[:=-]\s*([A-Z0-9./-]+)/i],
    ['valor_carga', /(?:valor(?:\s+total|\s+da\s+carga)?|vCarga|vNF)\s*[:=-]?\s*(?:R\$)?\s*([0-9.,]+)/i],
    ['cnpj_emitente', /(?:CNPJ\s+(?:emitente|emissor)|emitente)\s*[:=-]\s*([A-Z0-9./-]{14,24})/i],
    ['cnpj_remetente', /(?:CNPJ\s+remetente|remetente)\s*[:=-]\s*([A-Z0-9./-]{14,24})/i],
    ['cnpj_destinatario', /(?:CNPJ\s+destinat[aá]rio|destinat[aá]rio)\s*[:=-]\s*([A-Z0-9./-]{14,24})/i],
    ['cnpj_tomador', /(?:CNPJ\s+tomador|tomador)\s*[:=-]\s*([A-Z0-9./-]{14,24})/i],
    ['protocolo', /(?:protocolo|nProt)\s*[:=-]\s*([A-Z0-9.-]+)/i]
  ];

  for (const [key, regex] of patterns) {
    const match = text.match(regex);
    if (match?.[1]) row[key] = match[1];
  }
  return row;
}

function extractKnownXmlDocuments(text: string): string[] {
  const roots = ['cteProc', 'CTe', 'nfeProc', 'NFe', 'mdfeProc', 'MDFe', 'CompNfse', 'Nfse', 'DPS'];
  const documents: string[] = [];

  for (const root of roots) {
    const regex = new RegExp(`<${root}\\b[\\s\\S]*?<\\/${root}>`, 'gi');
    for (const match of text.matchAll(regex)) {
      documents.push(match[0]);
    }
  }

  // Evita retornar documento interno (ex.: <CTe>) quando ele já está dentro de <cteProc>.
  return documents.filter(
    (candidate) =>
      !documents.some(
        (other) =>
          other !== candidate &&
          other.length > candidate.length &&
          other.includes(candidate)
      )
  );
}

export class MultiFormatFiscalParser {
  static supportedExtensions(): string[] {
    return ['.xml', '.csv', '.xlsx', '.pdf', '.txt'];
  }

  static async parse(file: {
    originalname: string;
    mimetype?: string;
    buffer: Buffer;
  }): Promise<ParsedUploadDocument[]> {
    const extension = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';

    if (!this.supportedExtensions().includes(extension)) {
      throw new Error(`UNSUPPORTED_FILE_FORMAT:${extension || 'sem_extensao'}`);
    }

    if (extension === '.xml') {
      const content = file.buffer.toString('utf8').trim();
      return [{ filename: file.originalname, format: 'XML', content, warnings: [] }];
    }

    if (extension === '.xlsx') {
      return this.parseExcel(file.originalname, file.buffer);
    }

    if (extension === '.pdf') {
      return this.parsePdf(file.originalname, file.buffer);
    }

    const text = file.buffer.toString('utf8');
    const embeddedXml = extractKnownXmlDocuments(text);
    if (embeddedXml.length > 0) {
      return embeddedXml.map((content, index) => ({
        filename: `${file.originalname}#xml-${index + 1}`,
        format: extension === '.csv' ? 'CSV' : 'TXT',
        content,
        warnings: []
      }));
    }

    const rows = delimitedRows(text);
    if (rows.length > 0) {
      return this.rowsToDocuments(
        file.originalname,
        extension === '.csv' ? 'CSV' : 'TXT',
        rows
      );
    }

    const canonical = buildCanonicalContent(keyValueRow(text));
    if (!canonical.content) {
      throw new Error(`INSUFFICIENT_FISCAL_DATA:${canonical.warnings.join('; ')}`);
    }

    return [{
      filename: file.originalname,
      format: extension === '.csv' ? 'CSV' : 'TXT',
      content: canonical.content,
      warnings: canonical.warnings
    }];
  }

  private static rowsToDocuments(
    filename: string,
    format: UploadFormat,
    rows: Row[]
  ): ParsedUploadDocument[] {
    const documents: ParsedUploadDocument[] = [];
    rows.forEach((row, index) => {
      const canonical = buildCanonicalContent(row);
      if (!canonical.content) return;
      documents.push({
        filename: `${filename}#linha-${index + 2}`,
        format,
        content: canonical.content,
        row_number: index + 2,
        warnings: canonical.warnings
      });
    });

    if (documents.length === 0) {
      throw new Error('INSUFFICIENT_FISCAL_DATA:nenhuma linha contém campos mínimos para averbação');
    }
    return documents;
  }

  private static async parseExcel(filename: string, buffer: Buffer): Promise<ParsedUploadDocument[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('EMPTY_SPREADSHEET');

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber - 1] = String(cell.text ?? cell.value ?? '').trim();
    });

    const rows: Row[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const item: Row = {};
      headers.forEach((header, index) => {
        if (!header) return;
        const cell = row.getCell(index + 1);
        item[header] = cell.text || cell.value || '';
      });
      if (Object.values(item).some((value) => String(value ?? '').trim().length > 0)) {
        rows.push(item);
      }
    });

    return this.rowsToDocuments(filename, 'XLSX', rows);
  }

  private static async parsePdf(filename: string, buffer: Buffer): Promise<ParsedUploadDocument[]> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.text ?? '';
      const embeddedXml = extractKnownXmlDocuments(text);
      if (embeddedXml.length > 0) {
        return embeddedXml.map((content, index) => ({
          filename: `${filename}#xml-${index + 1}`,
          format: 'PDF',
          content,
          warnings: []
        }));
      }

      const canonical = buildCanonicalContent(keyValueRow(text));
      if (!canonical.content) {
        throw new Error(`INSUFFICIENT_PDF_DATA:${canonical.warnings.join('; ')}`);
      }

      return [{
        filename,
        format: 'PDF',
        content: canonical.content,
        warnings: canonical.warnings
      }];
    } finally {
      await parser.destroy();
    }
  }
}

export const __testables = {
  buildCanonicalContent,
  delimitedRows,
  keyValueRow,
  normalizeTipo
};
