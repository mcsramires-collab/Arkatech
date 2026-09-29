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


describe('datas recebidas de integrações', () => {
  it.each(['2026-02-30', '2026-13-01', '2026-02-30T12:00:00Z', 20260929, {}, '2026-09-29T12:00:00'])('rejeita valor inválido %p sem lançar exceção', (value) => {
    expect(validatePolicyDocumentDate(basePolicy, value).reason).toBe('DOCUMENT_DATE_MISSING');
  });
  it('aceita dia bissexto real', () => {
    expect(validatePolicyDocumentDate({...basePolicy, vigencia_inicio:'2028-01-01', vigencia_fim:'2028-12-31'}, '2028-02-29').valid).toBe(true);
  });
});
