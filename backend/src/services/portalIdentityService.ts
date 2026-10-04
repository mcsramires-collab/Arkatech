import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { dbStore } from './dbStore';
import { TenantUser } from '../types';

export type PortalAccessPurpose = 'PASSWORD_RESET' | 'USER_INVITE';

interface PortalAccessTokenRecord {
  id: string;
  token_hash: string;
  purpose: PortalAccessPurpose;
  email: string;
  target_user_ids: string[];
  created_at: string;
  expires_at: string;
  used_at?: string;
  invalidated_at?: string;
}

export interface PortalAccessTokenInfo {
  purpose: PortalAccessPurpose;
  email_masked: string;
  expires_at: string;
}

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

function isInsuredPortalUser(user: TenantUser): boolean {
  const tenant = dbStore.tenants.find((item) => item.id === user.tenant_id);
  return tenant?.role === 'TRANSPORTADOR';
}

/**
 * Tokens públicos de recuperação/convite do Portal do Segurado.
 *
 * Segurança:
 * - o token em texto puro só existe no retorno de create* e no link enviado por e-mail;
 * - em disco guardamos apenas SHA-256 do token;
 * - tokens são de uso único e expiram;
 * - um novo token invalida os anteriores do mesmo objetivo/usuário;
 * - reset de senha vale para todas as empresas ativas ligadas ao mesmo e-mail, coerente com
 *   /auth/portal-login, que trata a pessoa como uma identidade multiempresa.
 */
class PortalIdentityServiceImpl {
  private records: PortalAccessTokenRecord[] = [];
  private readonly filePath: string;

  constructor() {
    this.filePath = path.join(
      process.env.DATA_DIR || path.join(__dirname, '../../'),
      'portal_access_tokens.json'
    );
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('[portalIdentity] Falha ao carregar tokens persistidos.', error);
      this.records = [];
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  private newToken(params: {
    purpose: PortalAccessPurpose;
    email: string;
    targetUserIds: string[];
    ttlMs: number;
  }): { token: string; expires_at: string } {
    const now = new Date();
    const token = crypto.randomBytes(32).toString('base64url');

    for (const record of this.records) {
      if (record.used_at || record.invalidated_at) continue;
      const sameEmailReset =
        params.purpose === 'PASSWORD_RESET' &&
        record.purpose === 'PASSWORD_RESET' &&
        record.email === params.email;
      const sameInviteTarget =
        params.purpose === 'USER_INVITE' &&
        record.purpose === 'USER_INVITE' &&
        record.target_user_ids.some((id) => params.targetUserIds.includes(id));
      if (sameEmailReset || sameInviteTarget) record.invalidated_at = now.toISOString();
    }

    const expiresAt = new Date(now.getTime() + params.ttlMs).toISOString();
    this.records.unshift({
      id: crypto.randomUUID(),
      token_hash: hashToken(token),
      purpose: params.purpose,
      email: params.email,
      target_user_ids: params.targetUserIds,
      created_at: now.toISOString(),
      expires_at: expiresAt
    });
    this.prune();
    this.persist();
    return { token, expires_at: expiresAt };
  }

  private prune(): void {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    // Guarda o último corte por usuário ainda cadastrado para que limpar o histórico
    // não revalide um JWT legado de longa duração anterior à troca de senha.
    const currentUserIds = new Set(dbStore.tenantUsers.map(user => user.id));
    const latestReset = new Map<string, PortalAccessTokenRecord>();
    for (const record of this.records) {
      if (record.purpose !== 'PASSWORD_RESET' || !record.used_at) continue;
      for (const userId of record.target_user_ids) {
        if (!currentUserIds.has(userId)) continue;
        const previous = latestReset.get(userId);
        if (!previous || new Date(record.used_at).getTime() > new Date(previous.used_at!).getTime()) {
          latestReset.set(userId, record);
        }
      }
    }
    const retainedIds = new Set([...latestReset.values()].map(record => record.id));
    this.records = this.records.filter((record) => {
      const terminalAt = record.used_at || record.invalidated_at || record.expires_at;
      return retainedIds.has(record.id) || new Date(terminalAt).getTime() >= cutoff;
    });
  }

  /**
   * Retorna undefined tanto para e-mail desconhecido quanto para rate-limit silencioso.
   * A rota pública sempre devolve a mesma mensagem, impedindo enumeração de contas.
   */
  createPasswordReset(emailInput: string): { token: string; expires_at: string } | undefined {
    const email = normalizeEmail(emailInput);
    const users = dbStore.tenantUsers.filter(
      (user) =>
        user.status === 'ATIVO' &&
        isInsuredPortalUser(user) &&
        normalizeEmail(user.email) === email
    );
    if (users.length === 0) return undefined;

    const recent = this.records.find(
      (record) =>
        record.purpose === 'PASSWORD_RESET' &&
        record.email === email &&
        !record.used_at &&
        !record.invalidated_at &&
        Date.now() - new Date(record.created_at).getTime() < 60_000
    );
    if (recent) return undefined;

    return this.newToken({
      purpose: 'PASSWORD_RESET',
      email,
      targetUserIds: users.map((user) => user.id),
      ttlMs: 60 * 60 * 1000
    });
  }

  createUserInvite(user: TenantUser): { token: string; expires_at: string } {
    if (!isInsuredPortalUser(user)) {
      throw new Error('PORTAL_USER_INVITE_INVALID_ROLE');
    }
    return this.newToken({
      purpose: 'USER_INVITE',
      email: normalizeEmail(user.email),
      targetUserIds: [user.id],
      ttlMs: 7 * 24 * 60 * 60 * 1000
    });
  }

  inspect(token: string): PortalAccessTokenInfo | null {
    const record = this.findValidRecord(token);
    if (!record) return null;
    return {
      purpose: record.purpose,
      email_masked: maskEmail(record.email),
      expires_at: record.expires_at
    };
  }

  private findValidRecord(token: string): PortalAccessTokenRecord | undefined {
    if (!token) return undefined;
    const tokenHash = hashToken(token);
    return this.records.find(
      (record) =>
        record.token_hash === tokenHash &&
        !record.used_at &&
        !record.invalidated_at &&
        new Date(record.expires_at).getTime() > Date.now()
    );
  }

  async consume(token: string, password: string): Promise<{
    purpose: PortalAccessPurpose;
    affected_users: number;
  }> {
    const record = this.findValidRecord(token);
    if (!record) throw new Error('PORTAL_ACCESS_TOKEN_INVALID');
    if (password.length < 8) throw new Error('PORTAL_PASSWORD_TOO_SHORT');

    const passwordHash = await bcrypt.hash(password, 10);
    // Revalida após o await: outro consumo, expiração ou reenvio pode ter invalidado o link.
    if (this.findValidRecord(token) !== record) throw new Error('PORTAL_ACCESS_TOKEN_INVALID');
    const targetUsers = dbStore.tenantUsers.filter((user) => {
      if (!record.target_user_ids.includes(user.id)) return false;
      if (!isInsuredPortalUser(user) || normalizeEmail(user.email) !== record.email) return false;
      if (record.purpose === 'PASSWORD_RESET') return user.status === 'ATIVO';
      return true;
    });
    if (targetUsers.length === 0) throw new Error('PORTAL_ACCESS_TARGET_MISSING');

    for (const user of targetUsers) {
      user.password_hash = passwordHash;
      if (record.purpose === 'USER_INVITE') user.status = 'ATIVO';
    }

    record.used_at = new Date().toISOString();
    // Um reset concluído invalida qualquer outro reset ainda aberto para o mesmo e-mail.
    for (const other of this.records) {
      if (
        other.id !== record.id &&
        !other.used_at &&
        !other.invalidated_at &&
        other.purpose === record.purpose &&
        (record.purpose === 'PASSWORD_RESET'
          ? other.email === record.email
          : other.target_user_ids.some((id) => record.target_user_ids.includes(id)))
      ) {
        other.invalidated_at = record.used_at;
      }
    }

    dbStore.persist();
    this.persist();
    return { purpose: record.purpose, affected_users: targetUsers.length };
  }

  /** Revoga JWTs pessoais emitidos antes de uma troca de senha já concluída. */
  isPortalSessionStale(userId: string, issuedAtSeconds: number | undefined): boolean {
    const issuedAtMs = typeof issuedAtSeconds === 'number' && Number.isFinite(issuedAtSeconds) && issuedAtSeconds > 0
      ? issuedAtSeconds * 1000 : undefined;
    return this.records.some(
      (record) =>
        record.purpose === 'PASSWORD_RESET' &&
        record.used_at &&
        record.target_user_ids.includes(userId) &&
        (issuedAtMs === undefined || new Date(record.used_at).getTime() >= issuedAtMs)
    );
  }

  /** Apenas para testes de contrato; nunca exposto por rota HTTP. */
  _debugRecords(): ReadonlyArray<PortalAccessTokenRecord> {
    return this.records;
  }
}

export const PortalIdentityService = new PortalIdentityServiceImpl();
