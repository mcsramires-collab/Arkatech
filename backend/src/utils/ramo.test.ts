import { normalizeRamo } from './ramo';

describe('normalizeRamo', () => {
  it.each([
    ['RCTRC', 'RCTRC'],
    ['RCTR-C', 'RCTRC'],
    ['rctr c', 'RCTRC'],
    ['RCDC', 'RCDC'],
    ['RC-DC', 'RCDC'],
    ['RCF-DC', 'RCDC'],
    ['RCV', 'RCV'],
    ['RC-V', 'RCV']
  ])('normaliza %s para %s', (input, expected) => {
    expect(normalizeRamo(input)).toBe(expected);
  });

  it('rejeita ramo desconhecido', () => {
    expect(normalizeRamo('OUTRO')).toBeUndefined();
  });
});
