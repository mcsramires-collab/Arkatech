import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import {
  WhatsappMessage,
  WhatsappMessageKind,
  WhatsappMessageStatus
} from '../types';
import { normalizeCnpj, sameCnpj } from '../utils/cnpj';

export function normalizePhone(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  // Brasil: mantém DDI quando informado; se vier somente DDD+número, assume 55.
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

export class WhatsappMessageService {
  static resolveTenant(params: {
    tenant_id?: string;
    tenant_cnpj?: string;
    phone?: string;
  }) {
    if (params.tenant_id) {
      return dbStore.tenants.find((tenant) => tenant.id === params.tenant_id);
    }

    if (params.tenant_cnpj) {
      const cnpj = normalizeCnpj(params.tenant_cnpj);
      const direct = dbStore.tenants.find((tenant) => sameCnpj(tenant.cnpj, cnpj));
      if (direct) return direct;

      const additional = dbStore.tenantCnpjsAdicionais.find(
        (item) => item.status === 'ATIVO' && sameCnpj(item.cnpj, cnpj)
      );
      return additional
        ? dbStore.tenants.find((tenant) => tenant.id === additional.tenant_id)
        : undefined;
    }

    const phone = normalizePhone(params.phone);
    if (!phone) return undefined;
    const matches = dbStore.tenants.filter(
      (tenant) => normalizePhone(tenant.contato_celular) === phone
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  static findInbound(provider: string, providerMessageId: string): WhatsappMessage | undefined {
    return dbStore.whatsappMessages.find(
      (item) =>
        item.direction === 'INBOUND' &&
        item.provider === provider &&
        item.provider_message_id === providerMessageId
    );
  }

  static createInbound(params: {
    tenant_id: string;
    provider: string;
    provider_message_id: string;
    phone: string;
    kind: WhatsappMessageKind;
    text?: string;
    document_name?: string;
    document_mime_type?: string;
    content?: Buffer;
  }): WhatsappMessage {
    const now = new Date().toISOString();
    const record: WhatsappMessage = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      provider: params.provider,
      provider_message_id: params.provider_message_id,
      direction: 'INBOUND',
      kind: params.kind,
      phone: normalizePhone(params.phone),
      text: params.text,
      document_name: params.document_name,
      document_mime_type: params.document_mime_type,
      content_hash_sha256: params.content
        ? crypto.createHash('sha256').update(params.content).digest('hex')
        : undefined,
      status: 'RECEIVED',
      fiscal_document_ids: [],
      created_at: now,
      updated_at: now
    };
    dbStore.whatsappMessages.unshift(record);
    dbStore.persist();
    return record;
  }

  static markProcessed(
    record: WhatsappMessage,
    params: {
      support_ticket_id?: string;
      fiscal_document_ids?: string[];
      error_message?: string;
    } = {}
  ): WhatsappMessage {
    const now = new Date().toISOString();
    record.support_ticket_id = params.support_ticket_id ?? record.support_ticket_id;
    record.fiscal_document_ids = params.fiscal_document_ids ?? record.fiscal_document_ids;
    record.error_message = params.error_message;
    record.status = params.error_message ? 'FAILED' : 'PROCESSED';
    record.processed_at = now;
    record.updated_at = now;
    dbStore.persist();
    return record;
  }

  static recipientForTicket(ticketId: string): string | undefined {
    return dbStore.whatsappMessages
      .filter(
        (item) =>
          item.direction === 'INBOUND' &&
          item.support_ticket_id === ticketId &&
          Boolean(item.phone)
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.phone;
  }

  static queueOutbound(params: {
    tenant_id: string;
    phone: string;
    text: string;
    support_ticket_id?: string;
    kind?: WhatsappMessageKind;
  }): WhatsappMessage {
    const now = new Date().toISOString();
    const record: WhatsappMessage = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      provider: 'GENERIC',
      direction: 'OUTBOUND',
      kind: params.kind ?? 'TEXT',
      phone: normalizePhone(params.phone),
      text: params.text,
      status: 'PENDING',
      support_ticket_id: params.support_ticket_id,
      attempt_count: 0,
      fiscal_document_ids: [],
      created_at: now,
      updated_at: now
    };
    dbStore.whatsappMessages.unshift(record);
    dbStore.persist();
    return record;
  }

  private static releaseExpiredClaims(): void {
    const now = Date.now();
    let changed = false;

    for (const item of dbStore.whatsappMessages) {
      if (
        item.direction === 'OUTBOUND' &&
        item.status === 'PROCESSING' &&
        item.claim_expires_at &&
        new Date(item.claim_expires_at).getTime() <= now
      ) {
        item.status = 'PENDING';
        item.claimed_by = undefined;
        item.claim_token = undefined;
        item.claim_expires_at = undefined;
        item.updated_at = new Date(now).toISOString();
        changed = true;
      }
    }

    if (changed) dbStore.persist();
  }

  static outbox(limit = 50): WhatsappMessage[] {
    this.releaseExpiredClaims();
    const safeLimit = Math.min(200, Math.max(1, limit));
    return dbStore.whatsappMessages
      .filter((item) => item.direction === 'OUTBOUND' && item.status === 'PENDING')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, safeLimit);
  }

  static claimOutbox(params: {
    worker_id: string;
    limit?: number;
    lease_seconds?: number;
  }): WhatsappMessage[] {
    this.releaseExpiredClaims();

    const safeLimit = Math.min(100, Math.max(1, params.limit ?? 20));
    const leaseSeconds = Math.min(900, Math.max(30, params.lease_seconds ?? 120));
    const now = Date.now();
    const expiresAt = new Date(now + leaseSeconds * 1000).toISOString();

    const selected = dbStore.whatsappMessages
      .filter((item) => item.direction === 'OUTBOUND' && item.status === 'PENDING')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, safeLimit);

    for (const item of selected) {
      item.status = 'PROCESSING';
      item.claimed_by = params.worker_id;
      item.claim_token = uuidv4();
      item.claim_expires_at = expiresAt;
      item.attempt_count = (item.attempt_count ?? 0) + 1;
      item.updated_at = new Date(now).toISOString();
    }

    if (selected.length > 0) dbStore.persist();
    return selected;
  }

  static updateOutboundStatus(params: {
    id: string;
    status: Extract<WhatsappMessageStatus, 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'>;
    provider?: string;
    provider_message_id?: string;
    error_message?: string;
    claim_token?: string;
  }): WhatsappMessage | undefined {
    const record = dbStore.whatsappMessages.find(
      (item) => item.id === params.id && item.direction === 'OUTBOUND'
    );
    if (!record) return undefined;
    if (
      record.status === 'PROCESSING' &&
      (!params.claim_token || params.claim_token !== record.claim_token)
    ) {
      return undefined;
    }

    record.status = params.status;
    if (params.provider) record.provider = params.provider;
    if (params.provider_message_id) record.provider_message_id = params.provider_message_id;
    record.error_message = params.error_message;
    record.claimed_by = undefined;
    record.claim_token = undefined;
    record.claim_expires_at = undefined;
    record.updated_at = new Date().toISOString();
    if (params.status !== 'FAILED') record.processed_at = record.updated_at;
    dbStore.persist();
    return record;
  }
}
