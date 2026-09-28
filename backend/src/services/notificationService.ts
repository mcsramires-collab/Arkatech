import { v4 as uuidv4 } from 'uuid';
import {
  OperationalNotification,
  OperationalNotificationType
} from '../types';
import { dbStore } from './dbStore';

export class NotificationService {
  static create(params: {
    tenant_id: string;
    tenant_user_id?: string;
    type: OperationalNotificationType;
    severity: OperationalNotification['severity'];
    title: string;
    message: string;
    context?: Record<string, any>;
  }): OperationalNotification {
    const notification: OperationalNotification = {
      id: uuidv4(),
      tenant_id: params.tenant_id,
      tenant_user_id: params.tenant_user_id,
      type: params.type,
      severity: params.severity,
      title: params.title,
      message: params.message,
      context: params.context,
      created_at: new Date().toISOString()
    };

    dbStore.operationalNotifications.unshift(notification);
    dbStore.persist();
    return notification;
  }

  static list(params: {
    tenant_id: string;
    tenant_user_id?: string;
    unread_only?: boolean;
    limit?: number;
  }): OperationalNotification[] {
    const limit = Math.min(200, Math.max(1, params.limit ?? 50));

    return dbStore.operationalNotifications
      .filter((item) => item.tenant_id === params.tenant_id)
      .filter(
        (item) =>
          !item.tenant_user_id ||
          (params.tenant_user_id && item.tenant_user_id === params.tenant_user_id)
      )
      .filter((item) => !params.unread_only || !item.read_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  static markRead(tenantId: string, id: string): OperationalNotification | undefined {
    const notification = dbStore.operationalNotifications.find(
      (item) => item.id === id && item.tenant_id === tenantId
    );
    if (!notification) return undefined;

    if (!notification.read_at) {
      notification.read_at = new Date().toISOString();
      dbStore.persist();
    }
    return notification;
  }

  static markAllRead(tenantId: string, tenantUserId?: string): number {
    const now = new Date().toISOString();
    let count = 0;

    for (const notification of dbStore.operationalNotifications) {
      if (notification.tenant_id !== tenantId || notification.read_at) continue;
      if (
        notification.tenant_user_id &&
        (!tenantUserId || notification.tenant_user_id !== tenantUserId)
      ) {
        continue;
      }
      notification.read_at = now;
      count += 1;
    }

    if (count > 0) dbStore.persist();
    return count;
  }
}
