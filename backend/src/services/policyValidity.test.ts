import { Policy } from '../types';
import { validatePolicyDocumentDate } from './policyValidity';

const basePolicy: Policy = {
  id: 'policy-test',
  numero_apolice: 'TEST-001',
  ramo: 'RCTRC',
  tenant_id: 'tenant-test',
  insurer_id: 'insurer-test',
  broker_id: 'broker-test',
  status: 'ATIVA',
  permitir_inativo_vencido: false,
  vigencia_inicio: '2026-09-29',
  vigencia_fim: '2027-09-28',
  aceita_averbacao_como_destinatario: false
};

describe('validatePolicyDocumentDate', () => {
  it('trata limites date-only como dias inclusivos no timezone de negócio', () => {
    expect(validatePolicyDocumentDate(basePolicy, '2026-09-28T23:59:59-03:00').reason)
      .toBe('BEFORE_POLICY_START');
    expect(validatePolicyDocumentDate(basePolicy, '2026-09-29T00:00:00-03:00').valid)
      .toBe(true);
    expect(validatePolicyDocumentDate(basePolicy, '2027-09-28T23:59:59-03:00').valid)
      .toBe(true);
    expect(validatePolicyDocumentDate(basePolicy, '2027-09-29T00:00:00-03:00').reason)
      .toBe('AFTER_POLICY_END');
  });

  it('compara timestamps exatos quando a apólice possui horário', () => {
    const policy = {
      ...basePolicy,
      vigencia_inicio: '2026-09-29T12:00:00.000Z',
      vigencia_fim: '2026-09-29T13:00:00.000Z'
    };

    expect(validatePolicyDocumentDate(policy, '2026-09-29T11:59:59.999Z').reason)
      .toBe('BEFORE_POLICY_START');
    expect(validatePolicyDocumentDate(policy, '2026-09-29T12:00:00.000Z').valid)
      .toBe(true);
    expect(validatePolicyDocumentDate(policy, '2026-09-29T13:00:00.000Z').valid)
      .toBe(true);
    expect(validatePolicyDocumentDate(policy, '2026-09-29T13:00:00.001Z').reason)
      .toBe('AFTER_POLICY_END');
  });

  it('não considera documento sem data como elegível', () => {
    expect(validatePolicyDocumentDate(basePolicy).reason).toBe('DOCUMENT_DATE_MISSING');
    expect(validatePolicyDocumentDate(basePolicy, 'data-invalida').reason)
      .toBe('DOCUMENT_DATE_MISSING');
  });
});
