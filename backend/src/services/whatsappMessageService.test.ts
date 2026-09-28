import { dbStore } from './dbStore';
import { WhatsappMessageService, normalizePhone } from './whatsappMessageService';

describe('WhatsappMessageService', () => {
  beforeEach(() => {
    dbStore.whatsappMessages = [];
    dbStore.tenants = [];
    dbStore.tenantCnpjsAdicionais = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.whatsappMessages = [];
    dbStore.tenants = [];
    dbStore.tenantCnpjsAdicionais = [];
    jest.restoreAllMocks();
  });

  it('normaliza telefone brasileiro sem DDI', () => {
    expect(normalizePhone('(19) 99999-0000')).toBe('5519999990000');
    expect(normalizePhone('+55 19 99999-0000')).toBe('5519999990000');
  });

  it('resolve tenant por CNPJ principal, adicional ativo ou telefone único', () => {
    dbStore.tenants = [{
      id: 'tenant-1',
      cnpj: '12ABC34501DE35',
      razao_social: 'Cliente',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client',
      client_secret_hash: 'secret',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      contato_celular: '(19) 99999-0000',
      created_at: new Date().toISOString()
    }] as any;
    dbStore.tenantCnpjsAdicionais = [{
      id: 'extra-1',
      tenant_id: 'tenant-1',
      cnpj: '98XYZ76543AB10',
      tipo: 'adicional',
      status: 'ATIVO',
      created_at: new Date().toISOString()
    }] as any;

    expect(WhatsappMessageService.resolveTenant({ tenant_cnpj: '12.ABC.345/01DE-35' })?.id)
      .toBe('tenant-1');
    expect(WhatsappMessageService.resolveTenant({ tenant_cnpj: '98.XYZ.765/43AB-10' })?.id)
      .toBe('tenant-1');
    expect(WhatsappMessageService.resolveTenant({ phone: '19999990000' })?.id)
      .toBe('tenant-1');
  });

  it('garante idempotência de inbound por provider_message_id', () => {
    const inbound = WhatsappMessageService.createInbound({
      tenant_id: 'tenant-1',
      provider: 'META',
      provider_message_id: 'wamid-1',
      phone: '5519999990000',
      kind: 'TEXT',
      text: 'Olá'
    });

    expect(WhatsappMessageService.findInbound('META', 'wamid-1')?.id).toBe(inbound.id);
  });

  it('enfileira resposta e atualiza confirmação do provider', () => {
    const outbound = WhatsappMessageService.queueOutbound({
      tenant_id: 'tenant-1',
      phone: '19999990000',
      text: 'Resposta',
      support_ticket_id: 'ticket-1'
    });

    expect(WhatsappMessageService.outbox()).toHaveLength(1);
    expect(outbound.status).toBe('PENDING');

    WhatsappMessageService.updateOutboundStatus({
      id: outbound.id,
      status: 'DELIVERED',
      provider: 'META',
      provider_message_id: 'wamid-out-1'
    });

    expect(WhatsappMessageService.outbox()).toHaveLength(0);
    expect(outbound).toMatchObject({
      status: 'DELIVERED',
      provider: 'META',
      provider_message_id: 'wamid-out-1'
    });
  });

  it('recupera o último telefone associado ao ticket de suporte', () => {
    const oldMessage = WhatsappMessageService.createInbound({
      tenant_id: 'tenant-1',
      provider: 'META',
      provider_message_id: 'old',
      phone: '5519111111111',
      kind: 'TEXT',
      text: 'Primeira'
    });
    oldMessage.support_ticket_id = 'ticket-1';
    oldMessage.created_at = '2026-09-27T10:00:00.000Z';

    const latest = WhatsappMessageService.createInbound({
      tenant_id: 'tenant-1',
      provider: 'META',
      provider_message_id: 'new',
      phone: '5519222222222',
      kind: 'TEXT',
      text: 'Segunda'
    });
    latest.support_ticket_id = 'ticket-1';
    latest.created_at = '2026-09-28T10:00:00.000Z';

    expect(WhatsappMessageService.recipientForTicket('ticket-1')).toBe('5519222222222');
  });
});
