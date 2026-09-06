import { many, one, query } from '../db/pool.js';
import { emitToUser } from '../realtime/emitter.js';

export type NotificationType =
  | 'new_message'
  | 'message_request'
  | 'request_accepted'
  | 'group_invite'
  | 'mention'
  | 'reply'
  | 'security_alert'
  | 'new_login'
  | 'moderation';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export async function createNotification(userId: string, input: NotificationInput) {
  const row = await one<{
    id: string;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    read_at: Date | null;
    created_at: Date;
  }>(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, type, title, body, data, read_at, created_at`,
    [userId, input.type, input.title, input.body ?? '', JSON.stringify(input.data ?? {})],
  );

  if (row) {
    emitToUser(userId, 'notification:new', {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      data: row.data,
      readAt: null,
      createdAt: new Date(row.created_at).toISOString(),
    });
  }
  return row;
}

export async function listNotifications(userId: string, limit = 50, unreadOnly = false) {
  const rows = await many<{
    id: string;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    read_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, type, title, body, data, read_at, created_at
       FROM notifications
      WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    data: r.data,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function countUnread(userId: string): Promise<number> {
  const row = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId],
  );
  return row?.count ?? 0;
}

export async function markRead(userId: string, ids: string[] | null): Promise<number> {
  const result = ids
    ? await query(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::uuid[])',
        [userId, ids],
      )
    : await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return result.rowCount ?? 0;
}
