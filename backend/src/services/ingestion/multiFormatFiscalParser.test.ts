import ExcelJS from '@protobi/exceljs';
import { MultiFormatFiscalParser, __testables } from './multiFormatFiscalParser';

describe('MultiFormatFiscalParser', () => {
  it('converte CSV fiscal por linha para o modelo canônico', async () => {
    const csv = [
      'tipo_documento;chave_documento;numero_documento;valor_carga;cnpj_emitente',
      'CTE;35123456789012345678901234567890123456789012;123;1500,50;12.ABC.345/01DE-35'
    ].join('\n');

    const docs = await MultiFormatFiscalParser.parse({
      originalname: 'carga.csv',
      mimetype: 'text/csv',
      buffer: Buffer.from(csv, 'utf8')
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.format).toBe('CSV');
    const parsed = JSON.parse(docs[0]!.content);
    expect(parsed).toMatchObject({
      tipoDocumento: 'CTE',
      numeroDocumento: '123',
      valorCarga: 1500.5,
      cnpjEmitente: '12ABC34501DE35'
    });
  });

  it('extrai campos de TXT chave-valor', async () => {
    const text = [
      'Tipo de Documento: NF-e',
      'Chave de Acesso: 35123456789012345678901234567890123456789012',
      'Número: 987',
      'Valor Total: R$ 2.345,67',
      'CNPJ Emitente: 12.ABC.345/01DE-35'
    ].join('\n');

    const docs = await MultiFormatFiscalParser.parse({
      originalname: 'nota.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from(text, 'utf8')
    });

    const parsed = JSON.parse(docs[0]!.content);
    expect(parsed.tipoDocumento).toBe('NFE');
    expect(parsed.valorCarga).toBe(2345.67);
    expect(parsed.cnpjEmitente).toBe('12ABC34501DE35');
  });

  it('lê a primeira planilha XLSX e transforma as linhas em documentos', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Averbacoes');
    sheet.addRow([
      'tipo_documento',
      'chave_documento',
      'numero_documento',
      'valor_carga',
      'cnpj_emitente'
    ]);
    sheet.addRow([
      'MDFE',
      '35123456789012345678901234567890123456789012',
      '456',
      9999.9,
      '12ABC34501DE35'
    ]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const docs = await MultiFormatFiscalParser.parse({
      originalname: 'averbacoes.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.format).toBe('XLSX');
    expect(JSON.parse(docs[0]!.content)).toMatchObject({
      tipoDocumento: 'MDFE',
      numeroDocumento: '456',
      valorCarga: 9999.9,
      cnpjEmitente: '12ABC34501DE35'
    });
  });

  it('rejeita linha sem os campos mínimos de averbação', () => {
    const result = __testables.buildCanonicalContent({
      tipo_documento: 'CTE',
      numero_documento: '123'
    });

    expect(result.content).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      'chave_documento deve conter 44 posições para CT-e/NF-e/MDF-e',
      'valor_carga ausente ou inválido'
    ]));
  });

  it('mantém XML embutido em TXT sem reconstruir dados', async () => {
    const xml = '<CTe><infCte Id="CTeABC123"><ide><nCT>1</nCT></ide></infCte></CTe>';
    const docs = await MultiFormatFiscalParser.parse({
      originalname: 'retorno.txt',
      buffer: Buffer.from(`prefixo\n${xml}\nsufixo`, 'utf8')
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.content).toBe(xml);
  });
});
