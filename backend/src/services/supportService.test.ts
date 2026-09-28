import { dbStore } from './dbStore';
import { SupportService } from './supportService';

describe('SupportService', () => {
  beforeEach(() => {
    dbStore.supportTickets = [];
    dbStore.supportMessages = [];
    dbStore.operationalNotifications = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.supportTickets = [];
    dbStore.supportMessages = [];
    dbStore.operationalNotifications = [];
    jest.restoreAllMocks();
  });

  it('abre chamado e cria a primeira mensagem da conversa', () => {
    const ticket = SupportService.createTicket({
      tenant_id: 'tenant-1',
      tenant_user_id: 'user-1',
      assunto: 'Erro na averbação',
      categoria: 'AVERBACAO',
      descricao: 'Documento não processou.',
      solicitante_nome: 'Cliente',
      canal_origem: 'CHAT',
      prioridade: 'ALTA'
    });

    expect(ticket).toMatchObject({
      status: 'ABERTO',
      prioridade: 'ALTA',
      canal_origem: 'CHAT'
    });
    expect(SupportService.messages(ticket.id, 'tenant-1')).toHaveLength(1);
    expect(SupportService.messages(ticket.id, 'tenant-1')[0]).toMatchObject({
      author_type: 'TENANT_USER',
      message: 'Documento não processou.'
    });
  });

  it('resposta interna coloca chamado em atendimento e notifica o usuário', () => {
    const ticket = SupportService.createTicket({
      tenant_id: 'tenant-1',
      tenant_user_id: 'user-1',
      assunto: 'Certificado',
      categoria: 'CERTIFICADO',
      descricao: 'Preciso de ajuda.',
      solicitante_nome: 'Cliente'
    });

    SupportService.addInternalMessage({
      ticket,
      author_id: 'agent-1',
      author_name: 'Agente Arckatech',
      message: 'Estamos analisando.'
    });

    expect(ticket.status).toBe('EM_ATENDIMENTO');
    expect(SupportService.messages(ticket.id, 'tenant-1')).toHaveLength(2);
    expect(dbStore.operationalNotifications).toHaveLength(1);
    expect(dbStore.operationalNotifications[0]).toMatchObject({
      tenant_user_id: 'user-1',
      type: 'SUPORTE'
    });
  });

  it('mensagem do cliente reabre ticket que aguardava cliente ou estava resolvido', () => {
    const ticket = SupportService.createTicket({
      tenant_id: 'tenant-1',
      assunto: 'Dúvida',
      categoria: 'GERAL',
      descricao: 'Primeira mensagem.',
      solicitante_nome: 'Cliente'
    });

    SupportService.updateTicket({ ticket, status: 'AGUARDANDO_CLIENTE' });
    SupportService.addTenantMessage({
      ticket,
      author_name: 'Cliente',
      message: 'Enviei a informação.'
    });
    expect(ticket.status).toBe('ABERTO');

    SupportService.updateTicket({ ticket, status: 'RESOLVIDO' });
    SupportService.addTenantMessage({
      ticket,
      author_name: 'Cliente',
      message: 'Ainda não resolveu.'
    });
    expect(ticket.status).toBe('ABERTO');
    expect(ticket.resolved_at).toBeUndefined();
  });
});
