import { DocumentTitularityService } from './documentTitularity';
import { ParsedDocumentData } from './xmlParser';

function baseDoc(overrides: Partial<ParsedDocumentData>): ParsedDocumentData {
  return {
    tipoDocumento: 'NFE',
    chaveDocumento: 'CHAVE',
    numeroDocumento: '1',
    valorCarga: 1000,
    tagsMap: {},
    rawXml: '<NFe/>',
    ...overrides
  };
}

describe('DocumentTitularityService', () => {
  it('aceita alias específico NF-e Transportador somente em NF-e', () => {
    const nfe = baseDoc({ cnpjTransportador: '12.345.678/0001-90' });
    const matchNfe = DocumentTitularityService.match(
      nfe,
      [{ funcao: 'NF-e: Transportador', habilitada: true }],
      '12.345.678/0001-90'
    );
    expect(matchNfe.matched).toBe(true);

    const cte = baseDoc({ tipoDocumento: 'CTE', cnpjTransportador: '12.345.678/0001-90' });
    const matchCte = DocumentTitularityService.match(
      cte,
      [{ funcao: 'NF-e: Transportador', habilitada: true }],
      '12.345.678/0001-90'
    );
    expect(matchCte.matched).toBe(false);
  });

  it('aceita CNPJ presente em autXML quando a função correspondente está habilitada', () => {
    const doc = baseDoc({ autXmlIds: ['11.111.111/0001-11', '22.222.222/0001-22'] });
    const result = DocumentTitularityService.match(
      doc,
      [{ funcao: 'AUTORIZADO_XML', habilitada: true }],
      '22.222.222/0001-22'
    );
    expect(result).toEqual({ matched: true, funcao: 'AUTORIZADO_XML' });
  });

  it('preserva a função genérica DESTINATARIO para compatibilidade', () => {
    const doc = baseDoc({ cnpjDestinatario: '33.333.333/0001-33' });
    const result = DocumentTitularityService.match(
      doc,
      [{ funcao: 'DESTINATARIO', habilitada: true }],
      '33.333.333/0001-33'
    );
    expect(result.matched).toBe(true);
  });
});
