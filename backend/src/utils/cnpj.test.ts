import {
  cnpjBase,
  isCnpjDvValid,
  isCnpjFormatValid,
  normalizeCnpj,
  sameCnpj
} from './cnpj';

describe('CNPJ alfanumerico', () => {
  it('preserva letras e remove apenas pontuacao', () => {
    expect(normalizeCnpj('12.ABC.345/01DE-35')).toBe('12ABC34501DE35');
  });

  it('aceita o exemplo oficial de CNPJ alfanumerico com DV valido', () => {
    expect(isCnpjFormatValid('12.ABC.345/01DE-35')).toBe(true);
    expect(isCnpjDvValid('12.ABC.345/01DE-35')).toBe(true);
  });

  it('mantem compatibilidade com CNPJ numerico', () => {
    expect(normalizeCnpj('12.345.678/0001-90')).toBe('12345678000190');
    expect(isCnpjFormatValid('12.345.678/0001-90')).toBe(true);
  });

  it('compara CNPJs independentemente da mascara e caixa', () => {
    expect(sameCnpj('12.abc.345/01de-35', '12ABC34501DE35')).toBe(true);
  });

  it('extrai a raiz preservando letras', () => {
    expect(cnpjBase('12.ABC.345/01DE-35')).toBe('12ABC345');
  });
});
