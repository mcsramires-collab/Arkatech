import { dbStore } from './dbStore';
import { NotificationService } from './notificationService';

describe('NotificationService', () => {
  beforeEach(() => {
    dbStore.operationalNotifications = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.operationalNotifications = [];
    jest.restoreAllMocks();
  });

  it('entrega notificação do tenant e privada somente ao usuário correto', () => {
    const general = NotificationService.create({
      tenant_id: 'tenant-1',
      type: 'SINCRONIZACAO_SEFAZ',
      severity: 'INFO',
      title: 'Sincronização',
      message: 'Tudo certo.'
    });
    const privateNotification = NotificationService.create({
      tenant_id: 'tenant-1',
      tenant_user_id: 'user-1',
      type: 'SUPORTE',
      severity: 'INFO',
      title: 'Suporte',
      message: 'Resposta disponível.'
    });

    expect(NotificationService.list({ tenant_id: 'tenant-1', tenant_user_id: 'user-1' }))
      .toEqual(expect.arrayContaining([general, privateNotification]));
    expect(NotificationService.list({ tenant_id: 'tenant-1', tenant_user_id: 'user-2' }))
      .toEqual([general]);
    expect(NotificationService.list({ tenant_id: 'tenant-1' })).toEqual([general]);
  });

  it('não permite marcar como lida a notificação privada de outro usuário', () => {
    const notification = NotificationService.create({
      tenant_id: 'tenant-1',
      tenant_user_id: 'user-1',
      type: 'SUPORTE',
      severity: 'INFO',
      title: 'Suporte',
      message: 'Resposta.'
    });

    expect(NotificationService.markRead('tenant-1', notification.id, 'user-2')).toBeUndefined();
    expect(notification.read_at).toBeUndefined();

    expect(NotificationService.markRead('tenant-1', notification.id, 'user-1')).toBeDefined();
    expect(notification.read_at).toBeDefined();
  });
});
