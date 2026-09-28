import { v4 as uuidv4 } from 'uuid';
import {
  SupportChannel,
  SupportMessage,
  SupportTicket,
  SupportTicketStatus
} from '../types';
import { dbStore } from './dbStore';
import { NotificationService } from './notificationService';

export class SupportService {
  static createTicket(params: {
    tenant_id: string;
    tenant_user_id?: string;
    assunto: string;
    categoria: string;
    descricao: string;
    solicitante_nome: string;
    prioridade?: SupportTicket['prioridade'];
    canal_origem?: SupportChannel;
  }): SupportTicket {
    const now = new Date().toISOString();
    const ticket: SupportTicket = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      tenant_user_id: params.tenant_user_id,
      assunto: params.assunto.trim(),
      categoria: params.categoria.trim(),
      descricao: params.descricao.trim(),
      status: 'ABERTO',
      prioridade: params.prioridade ?? 'NORMAL',
      canal_origem: params.canal_origem ?? 'PORTAL',
      solicitante_nome: params.solicitante_nome,
      updated_at: now,
      created_at: now
    };

    dbStore.supportTickets.unshift(ticket);
    dbStore.supportMessages.push({
      id: uuidv4(),
      ticket_id: ticket.id,
      tenant_id: ticket.tenant_id,
      author_type: 'TENANT_USER',
      author_id: params.tenant_user_id,
      author_name: params.solicitante_nome,
      channel: ticket.canal_origem,
      message: ticket.descricao,
      created_at: now
    });
    dbStore.persist();
    return ticket;
  }

  static getTicket(tenantId: string, ticketId: string): SupportTicket | undefined {
    return dbStore.supportTickets.find(
      (ticket) => ticket.id === ticketId && ticket.tenant_id === tenantId
    );
  }

  static messages(ticketId: string, tenantId: string): SupportMessage[] {
    return dbStore.supportMessages
      .filter((message) => message.ticket_id === ticketId && message.tenant_id === tenantId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  static addTenantMessage(params: {
    ticket: SupportTicket;
    tenant_user_id?: string;
    author_name: string;
    message: string;
    channel?: SupportChannel;
  }): SupportMessage {
    const now = new Date().toISOString();
    const entry: SupportMessage = {
      id: uuidv4(),
      ticket_id: params.ticket.id,
      tenant_id: params.ticket.tenant_id,
      author_type: 'TENANT_USER',
      author_id: params.tenant_user_id,
      author_name: params.author_name,
      channel: params.channel ?? 'CHAT',
      message: params.message.trim(),
      created_at: now
    };

    dbStore.supportMessages.push(entry);
    if (
      params.ticket.status === 'AGUARDANDO_CLIENTE' ||
      params.ticket.status === 'RESOLVIDO' ||
      params.ticket.status === 'FECHADO'
    ) {
      params.ticket.status = 'ABERTO';
      params.ticket.resolved_at = undefined;
      params.ticket.closed_at = undefined;
    }
    params.ticket.updated_at = now;
    dbStore.persist();
    return entry;
  }

  static addInternalMessage(params: {
    ticket: SupportTicket;
    author_id?: string;
    author_name: string;
    message: string;
    channel?: SupportChannel;
  }): SupportMessage {
    const now = new Date().toISOString();
    const entry: SupportMessage = {
      id: uuidv4(),
      ticket_id: params.ticket.id,
      tenant_id: params.ticket.tenant_id,
      author_type: 'ARCKATECH',
      author_id: params.author_id,
      author_name: params.author_name,
      channel: params.channel ?? 'CHAT',
      message: params.message.trim(),
      created_at: now
    };

    dbStore.supportMessages.push(entry);
    if (params.ticket.status === 'ABERTO') params.ticket.status = 'EM_ATENDIMENTO';
    params.ticket.updated_at = now;
    dbStore.persist();

    NotificationService.create({
      tenant_id: params.ticket.tenant_id,
      tenant_user_id: params.ticket.tenant_user_id,
      type: 'SUPORTE',
      severity: 'INFO',
      title: `Nova resposta no chamado ${params.ticket.assunto}`,
      message: params.message.trim(),
      context: { ticket_id: params.ticket.id }
    });

    return entry;
  }

  static updateTicket(params: {
    ticket: SupportTicket;
    status?: SupportTicketStatus;
    prioridade?: SupportTicket['prioridade'];
    assigned_to?: string;
  }): SupportTicket {
    const now = new Date().toISOString();

    if (params.status) {
      params.ticket.status = params.status;
      if (params.status === 'RESOLVIDO') params.ticket.resolved_at = now;
      if (params.status === 'FECHADO') params.ticket.closed_at = now;
      if (params.status !== 'RESOLVIDO') params.ticket.resolved_at = undefined;
      if (params.status !== 'FECHADO') params.ticket.closed_at = undefined;
    }
    if (params.prioridade) params.ticket.prioridade = params.prioridade;
    if (params.assigned_to !== undefined) params.ticket.assigned_to = params.assigned_to || undefined;

    params.ticket.updated_at = now;
    dbStore.persist();
    return params.ticket;
  }
}
