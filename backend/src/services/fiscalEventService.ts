import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Connector, FiscalEvent, FiscalSyncProvider } from '../types';
import { normalizeAlphanumeric } from '../utils/cnpj';
import { CancelamentoService } from './cancelamento';
import { dbStore } from './dbStore';
import { RawDocumentService } from './rawDocumentService';
import { NotificationService } from './notificationService';
import { XMLParserService } from './xmlParser';

export interface FiscalEventInput {
  nsu?: string;
  xml: string;
}

export interface FiscalEventResult {
  fiscal_event_id: string;
  status: FiscalEvent['status'];
  tipo_evento?: string;
  chave_documento?: string;
  averbacao_ids: string[];
  mensagem?: string;
}

export class FiscalEventService {
  static process(params: {
    connector: Connector;
    provider: FiscalSyncProvider;
    event: FiscalEventInput;
  }): FiscalEventResult {
    const { connector, provider, event } = params;
    const now = new Date().toISOString();
    const raw = RawDocumentService.store(event.xml, connector.tenant_id);
    const hash = crypto.createHash('sha256').update(event.xml, 'utf8').digest('hex');

    const duplicate = dbStore.fiscalEvents.find(
      (item) =>
        item.tenant_id === connector.tenant_id &&
        item.provider === provider &&
        item.content_hash_sha256 === hash
    );

    if (duplicate) {
      const record: FiscalEvent = {
        id: uuidv4(),
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        provider,
        nsu: event.nsu,
        tipo_evento: duplicate.tipo_evento,
        chave_documento: duplicate.chave_documento,
        status: 'DUPLICADO',
        content_hash_sha256: hash,
        raw_xml_id: raw.id,
        averbacao_ids: duplicate.averbacao_ids,
        mensagem: 'Evento fiscal já processado anteriormente.',
        received_at: now,
        processed_at: now
      };
      dbStore.fiscalEvents.unshift(record);
      dbStore.persist();
      return {
        fiscal_event_id: record.id,
        status: record.status,
        tipo_evento: record.tipo_evento,
        chave_documento: record.chave_documento,
        averbacao_ids: record.averbacao_ids,
        mensagem: record.mensagem
      };
    }

    let parsed: ReturnType<typeof XMLParserService.parseEventoCancelamento>;
    try {
      parsed = XMLParserService.parseEventoCancelamento(event.xml);
    } catch (error) {
      const record: FiscalEvent = {
        id: uuidv4(),
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        provider,
        nsu: event.nsu,
        status: 'ERRO',
        content_hash_sha256: hash,
        raw_xml_id: raw.id,
        averbacao_ids: [],
        mensagem: error instanceof Error ? error.message : 'Evento fiscal inválido.',
        received_at: now,
        processed_at: now
      };
      dbStore.fiscalEvents.unshift(record);
      dbStore.persist();
      return {
        fiscal_event_id: record.id,
        status: record.status,
        averbacao_ids: [],
        mensagem: record.mensagem
      };
    }

    if (parsed.tipoEvento !== '110111') {
      const record: FiscalEvent = {
        id: uuidv4(),
        tenant_id: connector.tenant_id,
        connector_id: connector.id,
        provider,
        nsu: event.nsu,
        tipo_evento: parsed.tipoEvento,
        chave_documento: parsed.chaveDocumentoCancelado,
        status: 'IGNORADO',
        content_hash_sha256: hash,
        raw_xml_id: raw.id,
        averbacao_ids: [],
        mensagem: `Evento ${parsed.tipoEvento} armazenado, mas ainda não possui ação automática configurada.`,
        received_at: now,
        processed_at: now
      };
      dbStore.fiscalEvents.unshift(record);
      dbStore.persist();
      return {
        fiscal_event_id: record.id,
        status: record.status,
        tipo_evento: record.tipo_evento,
        chave_documento: record.chave_documento,
        averbacao_ids: [],
        mensagem: record.mensagem
      };
    }

    const key = normalizeAlphanumeric(parsed.chaveDocumentoCancelado);
    const targets = dbStore.averbacoes.filter(
      (averbacao) =>
        averbacao.tenant_id === connector.tenant_id &&
        averbacao.status === 'SUCESSO' &&
        normalizeAlphanumeric(averbacao.chave_documento) === key
    );

    const cancelledIds: string[] = [];
    const errors: string[] = [];

    for (const target of targets) {
      const result = CancelamentoService.processar({
        averbacaoAnterior: target,
        xmlEvento: event.xml,
        requisitante: 'SEFAZ'
      });
      if (result.status === 'sucesso' && result.averbacao) {
        cancelledIds.push(result.averbacao.id);
      } else {
        errors.push(`${target.id}: ${result.mensagem}`);
      }
    }

    const status: FiscalEvent['status'] =
      targets.length === 0 ? 'IGNORADO' : cancelledIds.length > 0 && errors.length === 0 ? 'PROCESSADO' : 'ERRO';

    const mensagem =
      targets.length === 0
        ? 'Evento de cancelamento recebido, mas nenhuma averbação ativa correspondente foi encontrada.'
        : errors.length === 0
          ? `${cancelledIds.length} averbação(ões) cancelada(s) automaticamente pelo evento SEFAZ.`
          : errors.join(' | ');

    const record: FiscalEvent = {
      id: uuidv4(),
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      provider,
      nsu: event.nsu,
      tipo_evento: parsed.tipoEvento,
      chave_documento: parsed.chaveDocumentoCancelado,
      status,
      content_hash_sha256: hash,
      raw_xml_id: raw.id,
      averbacao_ids: cancelledIds,
      mensagem,
      received_at: now,
      processed_at: now
    };

    dbStore.fiscalEvents.unshift(record);
    dbStore.persist();

    if (record.status === 'PROCESSADO' && cancelledIds.length > 0) {
      NotificationService.create({
        tenant_id: connector.tenant_id,
        type: 'AVERBACAO_CANCELADA',
        severity: 'WARNING',
        title: 'Averbação cancelada pelo SEFAZ',
        message: record.mensagem || 'Um evento fiscal cancelou averbações vinculadas ao documento.',
        context: {
          fiscal_event_id: record.id,
          provider,
          chave_documento: record.chave_documento,
          averbacao_ids: cancelledIds
        }
      });
    }

    return {
      fiscal_event_id: record.id,
      status: record.status,
      tipo_evento: record.tipo_evento,
      chave_documento: record.chave_documento,
      averbacao_ids: record.averbacao_ids,
      mensagem: record.mensagem
    };
  }
}
