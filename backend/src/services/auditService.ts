import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'STATUS_CHANGE'
  | 'REVERSAL'
  | 'BULK_UPDATE'
  | 'BACKFILL';

export interface AuditActor {
  actor_type: 'INTERNAL_USER' | 'SEGURADORA' | 'CORRETORA' | 'SYSTEM';
  actor_id?: string;
  actor_name?: string;
  insurer_id?: string;
}

export interface AuditEvent {
  id: string;
  actor_type: AuditActor['actor_type'];
  actor_id?: string;
  actor_name?: string;
  insurer_id?: string;
  tenant_id?: string;
  policy_id?: string;
  module: string;
  entity_type: string;
  entity_id: string;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
  reason?: string;
  created_at: string;
}

export interface AuditFilters {
  insurer_id?: string;
  tenant_id?: string;
  policy_id?: string;
  module?: string;
  entity_type?: string;
  entity_id?: string;
  actor_id?: string;
  action?: AuditAction;
  from?: string;
  to?: string;
  limit?: number;
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export class AuditService {
  private events: AuditEvent[] = [];

  constructor(private readonly filePath: string = path.join(
    process.env.DATA_DIR || path.join(__dirname, '../../'),
    'audit_events.json'
  )) {
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.events = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('[AuditService] Falha ao carregar audit_events.json:', error);
      this.events = [];
    }
  }

  private persist() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.events, null, 2), 'utf-8');
  }

  record(input: Omit<AuditEvent, 'id' | 'created_at'>): AuditEvent {
    const event: AuditEvent = {
      id: uuidv4(),
      ...input,
      before: clone(input.before),
      after: clone(input.after),
      created_at: new Date().toISOString()
    };
    this.events.push(event);
    this.persist();
    return event;
  }

  list(filters: AuditFilters = {}): AuditEvent[] {
    const fromMs = filters.from ? Date.parse(filters.from) : undefined;
    const toMs = filters.to ? Date.parse(filters.to) : undefined;
    const limit = Math.max(1, Math.min(Number(filters.limit || 200), 1000));

    return this.events
      .filter((event) => !filters.insurer_id || event.insurer_id === filters.insurer_id)
      .filter((event) => !filters.tenant_id || event.tenant_id === filters.tenant_id)
      .filter((event) => !filters.policy_id || event.policy_id === filters.policy_id)
      .filter((event) => !filters.module || event.module === filters.module)
      .filter((event) => !filters.entity_type || event.entity_type === filters.entity_type)
      .filter((event) => !filters.entity_id || event.entity_id === filters.entity_id)
      .filter((event) => !filters.actor_id || event.actor_id === filters.actor_id)
      .filter((event) => !filters.action || event.action === filters.action)
      .filter((event) => fromMs === undefined || Date.parse(event.created_at) >= fromMs)
      .filter((event) => toMs === undefined || Date.parse(event.created_at) <= toMs)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(clone);
  }

  clearForTests() {
    this.events = [];
    this.persist();
  }
}

export const auditService = new AuditService();
