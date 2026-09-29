import { Policy } from '../types';

export type PolicyDocumentValidityReason =
  | 'DOCUMENT_DATE_MISSING'
  | 'BEFORE_POLICY_START'
  | 'AFTER_POLICY_END';

export interface PolicyDocumentValidity {
  valid: boolean;
  reason?: PolicyDocumentValidityReason;
  document_date?: string;
  policy_start?: string;
  policy_end?: string;
}

const DEFAULT_BUSINESS_TIMEZONE =
  process.env.POLICY_BUSINESS_TIMEZONE || 'America/Sao_Paulo';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value?: string): boolean {
  return Boolean(value && DATE_ONLY_RE.test(value.trim()));
}

function toDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('POLICY_VALIDITY_DATE_NORMALIZATION_FAILED');
  }

  return `${year}-${month}-${day}`;
}

function parseInstant(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function boundaryDateKey(value: string, timeZone: string): string | undefined {
  if (isDateOnly(value)) return value.trim();
  const parsed = parseInstant(value);
  return parsed ? toDateKey(parsed, timeZone) : undefined;
}

/**
 * Valida a vigência da apólice contra a DATA DE EMISSÃO do documento fiscal.
 *
 * Regras:
 * - limites date-only (YYYY-MM-DD) são inclusivos por dia civil no timezone de negócio;
 * - limites com timestamp são comparados como instante exato;
 * - documento sem data nunca é considerado elegível silenciosamente.
 */
export function validatePolicyDocumentDate(
  policy: Policy,
  documentDateValue?: string,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE
): PolicyDocumentValidity {
  const rawDocumentDate = documentDateValue?.trim();
  if (!rawDocumentDate) {
    return {
      valid: false,
      reason: 'DOCUMENT_DATE_MISSING',
      policy_start: policy.vigencia_inicio,
      policy_end: policy.vigencia_fim
    };
  }

  const documentIsDateOnly = isDateOnly(rawDocumentDate);
  const documentInstant = documentIsDateOnly ? undefined : parseInstant(rawDocumentDate);

  if (!documentIsDateOnly && !documentInstant) {
    return {
      valid: false,
      reason: 'DOCUMENT_DATE_MISSING',
      document_date: rawDocumentDate,
      policy_start: policy.vigencia_inicio,
      policy_end: policy.vigencia_fim
    };
  }

  const documentDateKey = documentIsDateOnly
    ? rawDocumentDate
    : toDateKey(documentInstant!, timeZone);

  if (policy.vigencia_inicio) {
    const start = policy.vigencia_inicio.trim();
    if (documentIsDateOnly || isDateOnly(start)) {
      const startKey = boundaryDateKey(start, timeZone);
      if (!startKey || documentDateKey < startKey) {
        return {
          valid: false,
          reason: 'BEFORE_POLICY_START',
          document_date: rawDocumentDate,
          policy_start: policy.vigencia_inicio,
          policy_end: policy.vigencia_fim
        };
      }
    } else {
      const startInstant = parseInstant(start);
      if (!startInstant || documentInstant!.getTime() < startInstant.getTime()) {
        return {
          valid: false,
          reason: 'BEFORE_POLICY_START',
          document_date: rawDocumentDate,
          policy_start: policy.vigencia_inicio,
          policy_end: policy.vigencia_fim
        };
      }
    }
  }

  if (policy.vigencia_fim) {
    const end = policy.vigencia_fim.trim();
    if (documentIsDateOnly || isDateOnly(end)) {
      const endKey = boundaryDateKey(end, timeZone);
      if (!endKey || documentDateKey > endKey) {
        return {
          valid: false,
          reason: 'AFTER_POLICY_END',
          document_date: rawDocumentDate,
          policy_start: policy.vigencia_inicio,
          policy_end: policy.vigencia_fim
        };
      }
    } else {
      const endInstant = parseInstant(end);
      if (!endInstant || documentInstant!.getTime() > endInstant.getTime()) {
        return {
          valid: false,
          reason: 'AFTER_POLICY_END',
          document_date: rawDocumentDate,
          policy_start: policy.vigencia_inicio,
          policy_end: policy.vigencia_fim
        };
      }
    }
  }

  return {
    valid: true,
    document_date: rawDocumentDate,
    policy_start: policy.vigencia_inicio,
    policy_end: policy.vigencia_fim
  };
}
