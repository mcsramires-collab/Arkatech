import { v4 as uuidv4 } from 'uuid';
import { dbStore } from './dbStore';
import {
  Connector,
  FiscalSyncProvider,
  FiscalSyncState,
  FiscalSyncStatus
} from '../types';

const ONE_HOUR_MS = 60 * 60 * 1000;

function nsuValue(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('INVALID_NSU');
  return BigInt(value);
}

export class FiscalSyncService {
  static report(
    connector: Connector,
    params: {
      provider: FiscalSyncProvider;
      status: FiscalSyncStatus;
      ult_nsu?: string;
      max_nsu?: string;
      cstat?: number;
      message?: string;
      document_count?: number;
      next_sync_after?: string;
    }
  ): FiscalSyncState {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let state = dbStore.fiscalSyncStates.find(
      (item) => item.connector_id === connector.id && item.provider === params.provider
    );

    const currentUlt = nsuValue(state?.ult_nsu);
    const currentMax = nsuValue(state?.max_nsu);
    const incomingUlt = nsuValue(params.ult_nsu);
    const incomingMax = nsuValue(params.max_nsu);

    if (currentUlt !== undefined && incomingUlt !== undefined && incomingUlt < currentUlt) {
      throw new Error('NSU_REGRESSION');
    }
    if (currentMax !== undefined && incomingMax !== undefined && incomingMax < currentMax) {
      throw new Error('MAX_NSU_REGRESSION');
    }
    if (incomingUlt !== undefined && incomingMax !== undefined && incomingUlt > incomingMax) {
      throw new Error('INVALID_NSU_RANGE');
    }

    const expectedStatusByCstat: Partial<Record<number, FiscalSyncStatus>> = {
      137: 'NO_DOCUMENTS',
      138: 'OK',
      656: 'RATE_LIMITED'
    };
    const expected = params.cstat !== undefined ? expectedStatusByCstat[params.cstat] : undefined;
    if (expected && params.status !== expected) {
      throw new Error('SYNC_STATUS_CSTAT_MISMATCH');
    }

    if (!state) {
      state = {
        id: uuidv4(),
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        provider: params.provider,
        status: 'NEVER_SYNCED',
        last_document_count: 0,
        created_at: now,
        updated_at: now
      };
      dbStore.fiscalSyncStates.push(state);
    }

    let nextSyncAfter = params.next_sync_after;
    if (params.cstat === 137 || params.cstat === 656) {
      const minNext = nowMs + ONE_HOUR_MS;
      const informed = nextSyncAfter ? new Date(nextSyncAfter).getTime() : 0;
      nextSyncAfter = new Date(Math.max(minNext, Number.isNaN(informed) ? 0 : informed)).toISOString();
    }

    state.status = params.status;
    if (params.ult_nsu !== undefined) state.ult_nsu = params.ult_nsu;
    if (params.max_nsu !== undefined) state.max_nsu = params.max_nsu;
    if (params.cstat !== undefined) state.last_cstat = params.cstat;
    if (params.message !== undefined) state.last_message = params.message;
    state.last_document_count = Math.max(0, params.document_count ?? 0);
    state.last_sync_at = now;
    state.next_sync_after = nextSyncAfter;
    state.updated_at = now;

    connector.last_sync_at = now;
    dbStore.persist();
    return state;
  }

  static getState(connectorId: string, provider: FiscalSyncProvider): FiscalSyncState | undefined {
    return dbStore.fiscalSyncStates.find(
      (item) => item.connector_id === connectorId && item.provider === provider
    );
  }

  static statesForConnector(connectorId: string): FiscalSyncState[] {
    return dbStore.fiscalSyncStates.filter((item) => item.connector_id === connectorId);
  }

  static publicResumeState(connector: Connector) {
    const result: Record<FiscalSyncProvider, {
      ult_nsu: string | null;
      max_nsu: string | null;
      status: FiscalSyncStatus;
      next_sync_after: string | null;
      last_sync_at: string | null;
    }> = {
      NFE: { ult_nsu: null, max_nsu: null, status: 'NEVER_SYNCED', next_sync_after: null, last_sync_at: null },
      CTE: { ult_nsu: null, max_nsu: null, status: 'NEVER_SYNCED', next_sync_after: null, last_sync_at: null },
      MDFE: { ult_nsu: null, max_nsu: null, status: 'NEVER_SYNCED', next_sync_after: null, last_sync_at: null }
    };

    for (const state of this.statesForConnector(connector.id)) {
      result[state.provider] = {
        ult_nsu: state.ult_nsu ?? null,
        max_nsu: state.max_nsu ?? null,
        status: state.status,
        next_sync_after: state.next_sync_after ?? null,
        last_sync_at: state.last_sync_at ?? null
      };
    }

    return result;
  }
}
