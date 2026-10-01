import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import { normalizeCnpj } from '../utils/cnpj';
import type { Policy, RamoApolice, Tenant } from '../types';

export type OnboardingDocumentType = 'APOLICE' | 'PROPOSTA' | 'DESCONHECIDO';
export type OnboardingExtractionLevel = 'COMPLETA' | 'PARCIAL' | 'INSUFICIENTE';
export type MigrationRamoCode = '54' | '55' | '59';
export type MigrationRequestStatus =
  | 'SOLICITADA'
  | 'DOCUMENTACAO_EM_ANALISE'
  | 'PROGRAMADA'
  | 'EFETIVADA'
  | 'RECUSADA';
export type MigrationAnalysisResult = 'APROVADA' | 'REVISAO_MANUAL' | 'RECUSADA';

export interface ExtractedValue<T = string> {
  value: T;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  source: string;
}

export interface OnboardingExtractedFields {
  cnpj?: ExtractedValue<string>;
  razao_social?: ExtractedValue<string>;
  cnpjs_adicionais?: ExtractedValue<string[]>;
  numero_apolice?: ExtractedValue<string>;
  lmi_lmg?: ExtractedValue<number>;
  vigencia_inicio?: ExtractedValue<string>;
  vigencia_fim?: ExtractedValue<string>;
  codigo_interno?: ExtractedValue<string>;
  corretora_nome?: ExtractedValue<string>;
  corretora_cnpj?: ExtractedValue<string>;
}

export interface AnalyzedOnboardingDocument {
  id: string;
  insurer_id: string;
  filename: string;
  mimetype: string;
  size: number;
  sha256: string;
  stored_path: string;
  document_type: OnboardingDocumentType;
  extraction_level: OnboardingExtractionLevel;
  fields: OnboardingExtractedFields;
  extracted_ramos: MigrationRamoCode[];
  migration_proof_eligible: boolean;
  analysis_warnings: string[];
  created_at: string;
}

export interface MigrationDetectionResult {
  migration_detected: boolean;
  cnpj: string;
  tenant_id?: string;
  insured_name?: string;
  eligible_ramos: MigrationRamoCode[];
}

export interface MigrationRequest {
  id: string;
  requester_insurer_id: string;
  tenant_id: string;
  cnpj: string;
  insured_name: string;
  selected_ramos: MigrationRamoCode[];
  document_ids: string[];
  term_accepted: true;
  analysis_result: MigrationAnalysisResult;
  analysis_reason?: string;
  status: MigrationRequestStatus;
  scheduled_start?: string;
  onboarding_completed: boolean;
  target_policy_ids: string[];
  requested_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  completed_at?: string;
  effective_at?: string;
}

interface OriginMigrationNotice {
  id: string;
  origin_insurer_id: string;
  migration_request_id: string;
  cnpj: string;
  insured_name: string;
  ramos: MigrationRamoCode[];
  scheduled_start?: string;
  read_at?: string;
  created_at: string;
}

interface MigrationStoreData {
  documents: AnalyzedOnboardingDocument[];
  requests: MigrationRequest[];
  origin_notices: OriginMigrationNotice[];
}

export class OnboardingMigrationError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
  }
}

const RAMO_TO_CODE: Record<RamoApolice, MigrationRamoCode> = {
  RCTRC: '54',
  RCDC: '55',
  RCV: '59'
};

const CODE_TO_RAMO: Record<MigrationRamoCode, RamoApolice> = {
  '54': 'RCTRC',
  '55': 'RCDC',
  '59': 'RCV'
};

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function parseMoney(raw: string): number | undefined {
  const clean = raw.replace(/R\$/gi, '').trim();
  if (!clean) return undefined;
  const normalized = clean.includes(',')
    ? clean.replace(/\./g, '').replace(',', '.')
    : clean.replace(/[^0-9.-]/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function toIsoDate(raw: string): string | undefined {
  const value = raw.trim();
  const br = value.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return undefined;
}

function normalizeText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\r/g, '');
}

function extractCnpjTokens(text: string): string[] {
  const matches = text.match(/\b(?:[A-Z0-9]{2}\.?[A-Z0-9]{3}\.?[A-Z0-9]{3}\/?[A-Z0-9]{4}-?[0-9]{2}|[A-Z0-9]{12}[0-9]{2})\b/gi) ?? [];
  return unique(matches.map(normalizeCnpj).filter((value) => /^[A-Z0-9]{12}[0-9]{2}$/.test(value)));
}

function extractRamos(text: string): MigrationRamoCode[] {
  const normalized = text.toUpperCase().replace(/\s+/g, ' ');
  const result: MigrationRamoCode[] = [];
  if (/\b(?:54|RCTR[ -]?C|RCTRC)\b/.test(normalized)) result.push('54');
  if (/\b(?:55|RCF[ -]?DC|RCDC)\b/.test(normalized)) result.push('55');
  if (/\b(?:59|RC[ -]?V|RCV)\b/.test(normalized)) result.push('59');
  return result;
}

function extractDocumentType(text: string): OnboardingDocumentType {
  if (/\bPROPOSTA\b/i.test(text)) return 'PROPOSTA';
  if (/\bAP[ÓO]LICE\b/i.test(text)) return 'APOLICE';
  return 'DESCONHECIDO';
}

function extractFields(textInput: string): {
  fields: OnboardingExtractedFields;
  ramos: MigrationRamoCode[];
  warnings: string[];
  type: OnboardingDocumentType;
} {
  const text = normalizeText(textInput);
  const warnings: string[] = [];
  const fields: OnboardingExtractedFields = {};
  const type = extractDocumentType(text);
  const cnpjs = extractCnpjTokens(text);

  const insuredCnpjMatch = text.match(/(?:CNPJ\s+(?:DO\s+)?SEGURADO|SEGURADO[\s\S]{0,40}?CNPJ)\s*[:=-]?\s*([A-Z0-9./-]{14,24})/i);
  const primaryCnpj = normalizeCnpj(insuredCnpjMatch?.[1] ?? cnpjs[0] ?? '');
  if (/^[A-Z0-9]{12}[0-9]{2}$/.test(primaryCnpj)) {
    fields.cnpj = {
      value: primaryCnpj,
      confidence: insuredCnpjMatch ? 'HIGH' : 'MEDIUM',
      source: insuredCnpjMatch ? 'rotulo CNPJ do segurado' : 'primeiro CNPJ identificado'
    };
  } else {
    warnings.push('CNPJ do segurado não identificado');
  }

  const extras = cnpjs.filter((cnpj) => cnpj !== primaryCnpj);
  if (extras.length) {
    fields.cnpjs_adicionais = {
      value: extras,
      confidence: 'LOW',
      source: 'demais CNPJs presentes no documento'
    };
  }

  const razao = text.match(/(?:RAZ[AÃ]O\s+SOCIAL\s+(?:DO\s+)?SEGURADO|SEGURADO)\s*[:=-]\s*([^\n]{3,120})/i)?.[1]?.trim();
  if (razao) {
    fields.razao_social = { value: razao, confidence: 'MEDIUM', source: 'rótulo do segurado' };
  }

  const numeroApolice = text.match(/AP[ÓO]LICE\s*(?:N[º°.]?|N[ÚU]MERO)?\s*[:=-]?\s*([A-Z0-9][A-Z0-9./-]{3,40})/i)?.[1]?.trim();
  if (numeroApolice) {
    fields.numero_apolice = { value: numeroApolice, confidence: 'HIGH', source: 'rótulo de apólice' };
  }

  const lmiMatch = text.match(/(?:LMI|LMG|LIMITE\s+M[ÁA]XIMO(?:\s+DE\s+INDENIZA[CÇ][AÃ]O)?)\s*[:=-]?\s*(?:R\$\s*)?([0-9][0-9.,]*)/i);
  const lmi = lmiMatch?.[1] ? parseMoney(lmiMatch[1]) : undefined;
  if (lmi !== undefined) {
    fields.lmi_lmg = { value: lmi, confidence: 'HIGH', source: 'rótulo LMI/LMG' };
  }

  const vigenciaBlock = text.match(/VIG[ÊE]NCIA[\s\S]{0,180}/i)?.[0] ?? '';
  const dateMatches = vigenciaBlock.match(/(?:\d{2}[\/-]\d{2}[\/-]\d{4}|\d{4}-\d{2}-\d{2})/g) ?? [];
  const inicio = dateMatches[0] ? toIsoDate(dateMatches[0]) : undefined;
  const fim = dateMatches[1] ? toIsoDate(dateMatches[1]) : undefined;
  if (inicio) fields.vigencia_inicio = { value: inicio, confidence: 'HIGH', source: 'bloco de vigência' };
  if (fim) fields.vigencia_fim = { value: fim, confidence: 'HIGH', source: 'bloco de vigência' };

  const codigoInterno = text.match(/C[ÓO]DIGO\s+INTERNO(?:\s+DA\s+SEGURADORA)?\s*[:=-]\s*([A-Z0-9./-]{2,50})/i)?.[1]?.trim();
  if (codigoInterno) {
    fields.codigo_interno = { value: codigoInterno, confidence: 'HIGH', source: 'rótulo código interno' };
  }

  const corretora = text.match(/CORRETORA(?:\s+L[ÍI]DER)?\s*[:=-]\s*([^\n]{3,120})/i)?.[1]?.trim();
  if (corretora) {
    fields.corretora_nome = { value: corretora, confidence: 'MEDIUM', source: 'rótulo corretora' };
  }
  const corretoraCnpjMatch = text.match(/CNPJ\s+(?:DA\s+)?CORRETORA\s*[:=-]?\s*([A-Z0-9./-]{14,24})/i)?.[1];
  const corretoraCnpj = normalizeCnpj(corretoraCnpjMatch ?? '');
  if (/^[A-Z0-9]{12}[0-9]{2}$/.test(corretoraCnpj)) {
    fields.corretora_cnpj = { value: corretoraCnpj, confidence: 'HIGH', source: 'rótulo CNPJ da corretora' };
  }

  const ramos = extractRamos(text);
  if (!ramos.length) warnings.push('Ramo 54/55/59 não identificado');
  if (type === 'DESCONHECIDO') warnings.push('Documento não classificado como apólice ou proposta');

  return { fields, ramos, warnings, type };
}

function extractionLevel(type: OnboardingDocumentType, fields: OnboardingExtractedFields, ramos: MigrationRamoCode[]): OnboardingExtractionLevel {
  const score = [
    Boolean(fields.cnpj),
    type !== 'DESCONHECIDO',
    ramos.length > 0,
    type === 'PROPOSTA' || Boolean(fields.numero_apolice),
    Boolean(fields.vigencia_inicio),
    Boolean(fields.vigencia_fim),
    Boolean(fields.lmi_lmg),
    Boolean(fields.razao_social)
  ].filter(Boolean).length;

  if (score >= 6) return 'COMPLETA';
  if (score >= 2) return 'PARCIAL';
  return 'INSUFICIENTE';
}

function findTenantByCnpj(cnpj: string): Tenant | undefined {
  const normalized = normalizeCnpj(cnpj);
  const direct = dbStore.tenants.find((tenant) => normalizeCnpj(tenant.cnpj) === normalized);
  if (direct) return direct;
  const additional = dbStore.tenantCnpjsAdicionais.find((item) => normalizeCnpj(item.cnpj) === normalized && item.ativo);
  return additional ? dbStore.tenants.find((tenant) => tenant.id === additional.tenant_id) : undefined;
}

function activePoliciesForTenant(tenantId: string): Policy[] {
  return dbStore.policies.filter((policy) => policy.tenant_id === tenantId && policy.status === 'ATIVA');
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'documento.bin';
}

function isoDateOnly(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = toIsoDate(value.slice(0, 10));
  return parsed;
}

export class OnboardingMigrationService {
  private readonly rootDir: string;
  private readonly filePath: string;
  private readonly documentDir: string;
  private data: MigrationStoreData;

  constructor(storageRoot?: string) {
    this.rootDir = storageRoot ?? process.env.DATA_DIR ?? path.join(__dirname, '../../');
    this.filePath = path.join(this.rootDir, 'onboarding_migration_store.json');
    this.documentDir = path.join(this.rootDir, 'onboarding_documents');
    this.data = this.load();
  }

  private load(): MigrationStoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<MigrationStoreData>;
        return {
          documents: parsed.documents ?? [],
          requests: parsed.requests ?? [],
          origin_notices: parsed.origin_notices ?? []
        };
      }
    } catch (error) {
      console.error('[onboardingMigration] Falha ao ler store; iniciando vazio.', error);
    }
    return { documents: [], requests: [], origin_notices: [] };
  }

  private persist(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  private async textFromFile(file: { originalname: string; mimetype: string; buffer: Buffer }): Promise<{ text: string; warnings: string[] }> {
    const lower = file.originalname.toLowerCase();
    if (lower.endsWith('.pdf') || file.mimetype === 'application/pdf') {
      const parser = new PDFParse({ data: file.buffer });
      try {
        const result = await parser.getText();
        return { text: result.text ?? '', warnings: [] };
      } finally {
        await parser.destroy();
      }
    }
    if (lower.endsWith('.txt') || file.mimetype.startsWith('text/')) {
      return { text: file.buffer.toString('utf8'), warnings: [] };
    }
    if (/\.(png|jpe?g)$/i.test(lower) || file.mimetype.startsWith('image/')) {
      return {
        text: '',
        warnings: ['Imagem recebida e preservada, mas OCR ainda não está configurado no backend; requer revisão documental.']
      };
    }
    throw new OnboardingMigrationError('UNSUPPORTED_ONBOARDING_DOCUMENT', 415, 'Formato não suportado. Envie PDF, PNG, JPG/JPEG ou TXT.');
  }

  detectMigration(cnpjInput: string, requesterInsurerId: string): MigrationDetectionResult {
    const cnpj = normalizeCnpj(cnpjInput);
    if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj)) {
      throw new OnboardingMigrationError('INVALID_CNPJ', 400, 'CNPJ inválido ou incompleto.');
    }
    const tenant = findTenantByCnpj(cnpj);
    if (!tenant) {
      return { migration_detected: false, cnpj, eligible_ramos: [] };
    }
    const outsidePolicies = activePoliciesForTenant(tenant.id).filter((policy) => policy.insurer_id !== requesterInsurerId);
    return {
      migration_detected: outsidePolicies.length > 0,
      cnpj,
      tenant_id: tenant.id,
      insured_name: tenant.razao_social,
      eligible_ramos: unique(outsidePolicies.map((policy) => RAMO_TO_CODE[policy.ramo])).sort()
    };
  }

  async analyzeDocument(
    requesterInsurerId: string,
    file: { originalname: string; mimetype: string; buffer: Buffer }
  ): Promise<AnalyzedOnboardingDocument & { migration: MigrationDetectionResult | null; scenario: 'NOVO' | 'MIGRACAO' | 'INDETERMINADO' }> {
    const insurer = dbStore.insurers.find((item) => item.id === requesterInsurerId);
    if (!insurer) throw new OnboardingMigrationError('INSURER_NOT_FOUND', 404, 'Seguradora não encontrada.');
    if (!file.buffer?.length) throw new OnboardingMigrationError('EMPTY_DOCUMENT', 400, 'Documento vazio.');

    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = this.data.documents.find((item) => item.insurer_id === requesterInsurerId && item.sha256 === sha256);
    if (duplicate) {
      const migration = duplicate.fields.cnpj?.value ? this.detectMigration(duplicate.fields.cnpj.value, requesterInsurerId) : null;
      return { ...duplicate, migration, scenario: migration ? (migration.migration_detected ? 'MIGRACAO' : 'NOVO') : 'INDETERMINADO' };
    }

    const { text, warnings: parserWarnings } = await this.textFromFile(file);
    const extraction = extractFields(text);
    const level = extractionLevel(extraction.type, extraction.fields, extraction.ramos);
    const proofEligible =
      extraction.type === 'APOLICE' &&
      Boolean(extraction.fields.cnpj) &&
      Boolean(extraction.fields.numero_apolice) &&
      Boolean(extraction.fields.vigencia_inicio) &&
      Boolean(extraction.fields.vigencia_fim) &&
      extraction.ramos.length > 0;

    fs.mkdirSync(this.documentDir, { recursive: true });
    const id = uuidv4();
    const storedPath = path.join(this.documentDir, `${id}-${safeFilename(file.originalname)}`);
    fs.writeFileSync(storedPath, file.buffer);

    const document: AnalyzedOnboardingDocument = {
      id,
      insurer_id: requesterInsurerId,
      filename: file.originalname,
      mimetype: file.mimetype || 'application/octet-stream',
      size: file.buffer.length,
      sha256,
      stored_path: storedPath,
      document_type: extraction.type,
      extraction_level: level,
      fields: extraction.fields,
      extracted_ramos: extraction.ramos,
      migration_proof_eligible: proofEligible,
      analysis_warnings: [...parserWarnings, ...extraction.warnings],
      created_at: new Date().toISOString()
    };
    this.data.documents.unshift(document);
    this.persist();

    const migration = document.fields.cnpj?.value ? this.detectMigration(document.fields.cnpj.value, requesterInsurerId) : null;
    return { ...document, migration, scenario: migration ? (migration.migration_detected ? 'MIGRACAO' : 'NOVO') : 'INDETERMINADO' };
  }

  getDocument(id: string, requesterInsurerId: string): AnalyzedOnboardingDocument {
    const document = this.data.documents.find((item) => item.id === id && item.insurer_id === requesterInsurerId);
    if (!document) throw new OnboardingMigrationError('DOCUMENT_NOT_FOUND', 404, 'Documento de onboarding não encontrado.');
    return document;
  }

  createMigrationRequest(input: {
    requesterInsurerId: string;
    cnpj: string;
    insuredName?: string;
    selectedRamos: MigrationRamoCode[];
    documentIds: string[];
    termAccepted: boolean;
    scheduledStart?: string;
  }): MigrationRequest {
    if (!input.termAccepted) {
      throw new OnboardingMigrationError('MIGRATION_TERM_REQUIRED', 400, 'O termo de responsabilidade precisa ser aceito.');
    }
    const selectedRamos = unique(input.selectedRamos).filter((item): item is MigrationRamoCode => ['54', '55', '59'].includes(item));
    if (!selectedRamos.length) {
      throw new OnboardingMigrationError('MIGRATION_BRANCH_REQUIRED', 400, 'Selecione pelo menos um ramo para migração.');
    }
    if (!input.documentIds.length) {
      throw new OnboardingMigrationError('MIGRATION_DOCUMENT_REQUIRED', 400, 'A migração exige documentação comprobatória.');
    }

    const detection = this.detectMigration(input.cnpj, input.requesterInsurerId);
    if (!detection.migration_detected || !detection.tenant_id) {
      throw new OnboardingMigrationError('MIGRATION_NOT_DETECTED', 409, 'Não existe cadastro ativo em outra seguradora para este CNPJ.');
    }
    const invalidRamo = selectedRamos.find((ramo) => !detection.eligible_ramos.includes(ramo));
    if (invalidRamo) {
      throw new OnboardingMigrationError('MIGRATION_BRANCH_NOT_ELIGIBLE', 409, `O ramo ${invalidRamo} não faz parte do cadastro elegível para migração.`);
    }

    const documents = input.documentIds.map((id) => this.getDocument(id, input.requesterInsurerId));
    const cnpj = normalizeCnpj(input.cnpj);
    const matchingProofs = documents.filter((document) =>
      document.migration_proof_eligible &&
      normalizeCnpj(document.fields.cnpj?.value) === cnpj
    );
    const coveredRamos = unique(matchingProofs.flatMap((document) => document.extracted_ramos));
    const approved = matchingProofs.length > 0 && selectedRamos.every((ramo) => coveredRamos.includes(ramo));
    const needsManualReview = documents.some((document) =>
      document.document_type === 'PROPOSTA' ||
      document.extraction_level === 'INSUFICIENTE' ||
      document.analysis_warnings.some((warning) => warning.includes('OCR'))
    );

    let analysisResult: MigrationAnalysisResult;
    let status: MigrationRequestStatus;
    let analysisReason: string | undefined;
    if (approved) {
      analysisResult = 'APROVADA';
      status = 'PROGRAMADA';
    } else if (needsManualReview) {
      analysisResult = 'REVISAO_MANUAL';
      status = 'DOCUMENTACAO_EM_ANALISE';
      analysisReason = 'A documentação foi preservada, mas não possui evidência estruturada suficiente para aprovação automática.';
    } else {
      analysisResult = 'RECUSADA';
      status = 'RECUSADA';
      analysisReason = 'A documentação analisada não comprova o CNPJ e todos os ramos selecionados.';
    }

    const request: MigrationRequest = {
      id: uuidv4(),
      requester_insurer_id: input.requesterInsurerId,
      tenant_id: detection.tenant_id,
      cnpj,
      insured_name: input.insuredName?.trim() || detection.insured_name || cnpj,
      selected_ramos: selectedRamos,
      document_ids: unique(input.documentIds),
      term_accepted: true,
      analysis_result: analysisResult,
      ...(analysisReason ? { analysis_reason: analysisReason } : {}),
      status,
      ...(isoDateOnly(input.scheduledStart) ? { scheduled_start: isoDateOnly(input.scheduledStart) } : {}),
      onboarding_completed: false,
      target_policy_ids: [],
      requested_at: new Date().toISOString()
    };
    this.data.requests.unshift(request);
    if (request.status === 'PROGRAMADA') this.createOriginNotices(request);
    this.persist();
    return request;
  }

  listRequests(requesterInsurerId: string): MigrationRequest[] {
    return this.data.requests.filter((request) => request.requester_insurer_id === requesterInsurerId);
  }

  reviewRequest(requestId: string, reviewerId: string, decision: 'APPROVE' | 'REJECT', reason?: string): MigrationRequest {
    const request = this.data.requests.find((item) => item.id === requestId);
    if (!request) throw new OnboardingMigrationError('MIGRATION_REQUEST_NOT_FOUND', 404, 'Solicitação de migração não encontrada.');
    if (request.status !== 'DOCUMENTACAO_EM_ANALISE') {
      throw new OnboardingMigrationError('MIGRATION_REVIEW_NOT_ALLOWED', 409, 'A solicitação não está aguardando revisão documental.');
    }
    request.reviewed_at = new Date().toISOString();
    request.reviewed_by = reviewerId;
    if (decision === 'APPROVE') {
      request.analysis_result = 'APROVADA';
      request.status = 'PROGRAMADA';
      request.analysis_reason = reason?.trim() || 'Documentação aprovada em revisão manual.';
      this.createOriginNotices(request);
    } else {
      request.analysis_result = 'RECUSADA';
      request.status = 'RECUSADA';
      request.analysis_reason = reason?.trim() || 'Documentação recusada em revisão manual.';
    }
    this.persist();
    return request;
  }

  completeOnboarding(requestId: string, requesterInsurerId: string, targetPolicyIds: string[]): MigrationRequest {
    const request = this.data.requests.find((item) => item.id === requestId && item.requester_insurer_id === requesterInsurerId);
    if (!request) throw new OnboardingMigrationError('MIGRATION_REQUEST_NOT_FOUND', 404, 'Solicitação de migração não encontrada.');
    if (request.status !== 'PROGRAMADA') {
      throw new OnboardingMigrationError('MIGRATION_NOT_PROGRAMMED', 409, 'Somente uma migração programada pode concluir o onboarding.');
    }
    const selectedRamos = request.selected_ramos.map((code) => CODE_TO_RAMO[code]);
    const policies = unique(targetPolicyIds).map((id) => dbStore.policies.find((policy) => policy.id === id));
    if (policies.some((policy) => !policy)) {
      throw new OnboardingMigrationError('TARGET_POLICY_NOT_FOUND', 404, 'Uma ou mais apólices de destino não foram encontradas.');
    }
    const invalid = policies.find((policy) =>
      policy!.insurer_id !== requesterInsurerId ||
      policy!.tenant_id !== request.tenant_id ||
      !selectedRamos.includes(policy!.ramo)
    );
    if (invalid) {
      throw new OnboardingMigrationError('TARGET_POLICY_SCOPE_INVALID', 403, 'A apólice de destino não pertence à seguradora, ao cadastro ou aos ramos desta migração.');
    }
    const policyRamos = unique(policies.map((policy) => policy!.ramo));
    const missing = selectedRamos.find((ramo) => !policyRamos.includes(ramo));
    if (missing) {
      throw new OnboardingMigrationError('TARGET_POLICY_REQUIRED_FOR_EACH_BRANCH', 409, `Falta apólice de destino para o ramo ${RAMO_TO_CODE[missing]}.`);
    }
    request.target_policy_ids = unique(targetPolicyIds);
    request.onboarding_completed = true;
    request.completed_at = new Date().toISOString();
    this.persist();
    return request;
  }

  effectMigration(requestId: string, requesterInsurerId: string, at = new Date()): MigrationRequest {
    const request = this.data.requests.find((item) => item.id === requestId && item.requester_insurer_id === requesterInsurerId);
    if (!request) throw new OnboardingMigrationError('MIGRATION_REQUEST_NOT_FOUND', 404, 'Solicitação de migração não encontrada.');
    if (request.status !== 'PROGRAMADA') {
      throw new OnboardingMigrationError('MIGRATION_NOT_PROGRAMMED', 409, 'A migração não está programada para efetivação.');
    }
    if (!request.onboarding_completed) {
      throw new OnboardingMigrationError('MIGRATION_ONBOARDING_INCOMPLETE', 409, 'Conclua o onboarding e vincule as apólices de destino antes de efetivar a migração.');
    }
    const scheduled = request.scheduled_start ? new Date(`${request.scheduled_start}T00:00:00.000Z`) : undefined;
    if (scheduled && at.getTime() < scheduled.getTime()) {
      throw new OnboardingMigrationError('MIGRATION_NOT_DUE', 409, `Migração programada para ${request.scheduled_start}.`);
    }

    const targetPolicies = request.target_policy_ids.map((id) => dbStore.policies.find((policy) => policy.id === id));
    if (targetPolicies.some((policy) => !policy || policy!.status !== 'ATIVA')) {
      throw new OnboardingMigrationError('TARGET_POLICY_NOT_ACTIVE', 409, 'Todas as apólices de destino precisam existir e estar ativas.');
    }
    for (const code of request.selected_ramos) {
      const ramo = CODE_TO_RAMO[code];
      const target = targetPolicies.find((policy) => policy!.ramo === ramo);
      if (!target) {
        throw new OnboardingMigrationError('TARGET_POLICY_REQUIRED_FOR_EACH_BRANCH', 409, `Falta apólice de destino para o ramo ${code}.`);
      }
      const sources = activePoliciesForTenant(request.tenant_id).filter((policy) =>
        policy.insurer_id !== requesterInsurerId && policy.ramo === ramo
      );
      if (!sources.length) {
        throw new OnboardingMigrationError('SOURCE_POLICY_NOT_ACTIVE', 409, `Não existe mais apólice ativa de origem para o ramo ${code}.`);
      }
    }

    for (const code of request.selected_ramos) {
      const ramo = CODE_TO_RAMO[code];
      activePoliciesForTenant(request.tenant_id)
        .filter((policy) => policy.insurer_id !== requesterInsurerId && policy.ramo === ramo)
        .forEach((policy) => {
          policy.status = 'INATIVA';
        });
    }
    dbStore.persist();
    request.status = 'EFETIVADA';
    request.effective_at = at.toISOString();
    this.persist();
    return request;
  }

  listOriginNotices(originInsurerId: string): Array<Omit<OriginMigrationNotice, 'origin_insurer_id' | 'migration_request_id'>> {
    return this.data.origin_notices
      .filter((notice) => notice.origin_insurer_id === originInsurerId)
      .map(({ origin_insurer_id: _origin, migration_request_id: _request, ...safe }) => safe);
  }

  markOriginNoticeRead(originInsurerId: string, noticeId: string): Omit<OriginMigrationNotice, 'origin_insurer_id' | 'migration_request_id'> {
    const notice = this.data.origin_notices.find((item) => item.id === noticeId && item.origin_insurer_id === originInsurerId);
    if (!notice) throw new OnboardingMigrationError('MIGRATION_NOTICE_NOT_FOUND', 404, 'Aviso de migração não encontrado.');
    notice.read_at = notice.read_at ?? new Date().toISOString();
    this.persist();
    const { origin_insurer_id: _origin, migration_request_id: _request, ...safe } = notice;
    return safe;
  }

  private createOriginNotices(request: MigrationRequest): void {
    for (const code of request.selected_ramos) {
      const ramo = CODE_TO_RAMO[code];
      const originIds = unique(
        activePoliciesForTenant(request.tenant_id)
          .filter((policy) => policy.insurer_id !== request.requester_insurer_id && policy.ramo === ramo)
          .map((policy) => policy.insurer_id)
      );
      for (const originInsurerId of originIds) {
        const existing = this.data.origin_notices.find((notice) =>
          notice.origin_insurer_id === originInsurerId &&
          notice.migration_request_id === request.id
        );
        if (existing) {
          existing.ramos = unique([...existing.ramos, code]).sort();
          continue;
        }
        this.data.origin_notices.unshift({
          id: uuidv4(),
          origin_insurer_id: originInsurerId,
          migration_request_id: request.id,
          cnpj: request.cnpj,
          insured_name: request.insured_name,
          ramos: [code],
          ...(request.scheduled_start ? { scheduled_start: request.scheduled_start } : {}),
          created_at: new Date().toISOString()
        });
      }
    }
  }

  /** Test helper: does not touch dbStore and is intentionally not exposed through HTTP. */
  snapshot(): MigrationStoreData {
    return JSON.parse(JSON.stringify(this.data)) as MigrationStoreData;
  }
}

export const onboardingMigrationService = new OnboardingMigrationService();
