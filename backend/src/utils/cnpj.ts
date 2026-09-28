/**
 * Utilitários de CNPJ preparados para o formato alfanumérico em produção desde 2026.
 *
 * Estrutura oficial: 12 caracteres alfanuméricos (0-9, A-Z) + 2 dígitos verificadores numéricos.
 * Não use replace(/\D/g, '') em CNPJ: isso destrói letras válidas.
 */

export function normalizeCnpj(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isCnpjFormatValid(value: unknown): boolean {
  return /^[A-Z0-9]{12}[0-9]{2}$/.test(normalizeCnpj(value));
}

export function cnpjBase(value: unknown): string {
  const normalized = normalizeCnpj(value);
  return normalized.length === 14 ? normalized.slice(0, 8) : '';
}

export function sameCnpj(a: unknown, b: unknown): boolean {
  const left = normalizeCnpj(a);
  const right = normalizeCnpj(b);
  return left.length === 14 && right.length === 14 && left === right;
}

function charValue(char: string): number {
  return char.charCodeAt(0) - 48;
}

function calculateDv(base: string): string {
  const firstWeights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const firstSum = base
    .split('')
    .reduce((sum, char, index) => sum + charValue(char) * firstWeights[index]!, 0);
  const firstRemainder = firstSum % 11;
  const firstDv = firstRemainder < 2 ? 0 : 11 - firstRemainder;

  const secondBase = base + String(firstDv);
  const secondWeights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const secondSum = secondBase
    .split('')
    .reduce((sum, char, index) => sum + charValue(char) * secondWeights[index]!, 0);
  const secondRemainder = secondSum % 11;
  const secondDv = secondRemainder < 2 ? 0 : 11 - secondRemainder;

  return `${firstDv}${secondDv}`;
}

/**
 * Validação completa do DV oficial. Mantida separada de isCnpjFormatValid para não quebrar
 * cadastros legados/mocks que historicamente não validavam DV no produto.
 */
export function isCnpjDvValid(value: unknown): boolean {
  const normalized = normalizeCnpj(value);
  if (!isCnpjFormatValid(normalized)) return false;
  return calculateDv(normalized.slice(0, 12)) === normalized.slice(12);
}
