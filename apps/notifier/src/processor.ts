import { createHmac } from 'crypto';
import { fetch } from 'undici';
import { CONFIG } from './config.js';
import { withTransaction } from './db.js';
import type { PoolClient } from 'pg';

interface NotificationRow {
  notification_id: string;
  tenant_id: string;
  job_type: string;
  job_id: string;
  reference_id: string;
  status: string;
  summary: Record<string, unknown> | null;
  error: string | null;
}

export async function processNextNotification(): Promise<boolean> {
  return withTransaction(async (client) => {
    const selectSql = createNotificationSelectSql();
    const res = await client.query<NotificationRow>(selectSql);

    if (res.rowCount === 0) {
      return false;
    }

    const notification = res.rows[0];

    try {
      await deliverNotification(notification);
      await markAsDelivered(client, notification.notification_id);
    } catch (error) {
      await rescheduleNotification(client, notification.notification_id, error);
    }

    return true;
  });
}

function createNotificationSelectSql(): string {
  const base = `SELECT notification_id, tenant_id, job_type, job_id, reference_id, status, summary, error
         FROM job_notifications
        WHERE delivered_at IS NULL AND available_at <= NOW()
        ORDER BY created_at
        LIMIT 1`;

  if (CONFIG.env === 'test') {
    return base;
  }

  return `${base} FOR UPDATE SKIP LOCKED`;
}

async function deliverNotification(notification: NotificationRow): Promise<void> {
  const payload = {
    tenantId: notification.tenant_id,
    jobType: notification.job_type,
    jobId: notification.job_id,
    referenceId: notification.reference_id,
    status: notification.status,
    summary: notification.summary,
    error: notification.error,
  };

  if (!CONFIG.webhookUrl) {
    console.warn('[notifier] webhook url not configured, skipping delivery', payload);
    return;
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tenant-id': notification.tenant_id,
    'x-job-type': notification.job_type,
    'x-job-id': notification.job_id,
  };

  if (CONFIG.webhookSecret) {
    const signature = createHmac('sha256', CONFIG.webhookSecret).update(body).digest('hex');
    headers['x-signature-sha256'] = signature;
  }

  const response = await fetch(CONFIG.webhookUrl, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook delivery failed with status ${response.status}: ${text}`);
  }
}

async function markAsDelivered(client: PoolClient, notificationId: string): Promise<void> {
  await client.query(
    `UPDATE job_notifications
        SET delivered_at = NOW(),
            delivery_attempts = delivery_attempts + 1
      WHERE notification_id = $1`,
    [notificationId],
  );
}

async function rescheduleNotification(client: PoolClient, notificationId: string, error: unknown): Promise<void> {
  const availableAt = new Date(Date.now() + CONFIG.pollIntervalMs * 5);
  const message = error instanceof Error ? error.message : String(error);

  await client.query(
    `UPDATE job_notifications
        SET available_at = $2,
            delivery_attempts = delivery_attempts + 1,
            error = $3
      WHERE notification_id = $1`,
    [notificationId, availableAt.toISOString(), truncateError(message)],
  );
}

function truncateError(message: string): string {
  if (message.length <= 1024) {
    return message;
  }
  return message.slice(0, 1024);
}
