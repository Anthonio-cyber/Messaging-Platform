import { many, one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { avatarUrl, removeContactEdge } from './user.service.js';
import { createNotification } from './notification.service.js';
import { disconnectUserSockets } from '../realtime/emitter.js';

export const REPORT_CATEGORIES = [
  'spam',
  'harassment',
  'hate_speech',
  'violence_or_threats',
  'sexual_content',
  'child_safety',
  'scam_or_fraud',
  'impersonation',
  'self_harm',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) throw badRequest('You cannot block yourself.');
  const target = await one('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [blockedId]);
  if (!target) throw notFound('That account does not exist.');

  await transaction(async (client) => {
    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      blockerId,
      blockedId,
    ]);
    // A block ends any pending approach in either direction.
    await client.query(
      `UPDATE message_requests SET status = 'blocked', responded_at = now()
        WHERE status = 'pending'
          AND ((sender_id = $2 AND recipient_id = $1) OR (sender_id = $1 AND recipient_id = $2))`,
      [blockerId, blockedId],
    );
  });
  await removeContactEdge(blockerId, blockedId);
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  const result = await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
    blockerId,
    blockedId,
  ]);
  if ((result.rowCount ?? 0) === 0) throw notFound('That person is not blocked.');
}

export async function listBlocked(userId: string) {
  const rows = await many<{
    id: string;
    username: string;
    custom_address: string;
    display_name: string;
    avatar_key: string | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.username, u.custom_address, u.display_name, u.avatar_key, b.created_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    customAddress: r.custom_address,
    displayName: r.display_name,
    avatarUrl: avatarUrl(r.avatar_key),
    blockedAt: new Date(r.created_at).toISOString(),
  }));
}

export interface ReportInput {
  reporterId: string;
  targetType: 'user' | 'message' | 'conversation';
  reportedUserId?: string | null;
  messageId?: string | null;
  conversationId?: string | null;
  category: ReportCategory;
  reason: string;
  /**
   * Optional plaintext excerpt captured on the reporter's own device. Messages are end-to-end
   * encrypted, so this is the only way a moderator can see reported content — and it only ever
   * exists because the reporter chose to include it.
   */
  evidence?: { excerpt?: string; capturedAt?: string } | null;
}

export async function createReport(input: ReportInput): Promise<{ id: string }> {
  if (input.targetType === 'message' && !input.messageId) throw badRequest('A message must be identified.');
  if (input.targetType === 'user' && !input.reportedUserId) throw badRequest('An account must be identified.');

  // One open report per reporter per target keeps the queue meaningful.
  const duplicate = await one<{ id: string }>(
    `SELECT id FROM reports
      WHERE reporter_id = $1 AND status IN ('open','reviewing')
        AND coalesce(reported_user_id::text,'') = coalesce($2::text,'')
        AND coalesce(message_id::text,'') = coalesce($3::text,'')
        AND coalesce(conversation_id::text,'') = coalesce($4::text,'')`,
    [input.reporterId, input.reportedUserId ?? null, input.messageId ?? null, input.conversationId ?? null],
  );
  if (duplicate) throw conflict('You already reported this. Our team is reviewing it.');

  let reportedUserId = input.reportedUserId ?? null;
  if (!reportedUserId && input.messageId) {
    const message = await one<{ sender_id: string | null }>('SELECT sender_id FROM messages WHERE id = $1', [
      input.messageId,
    ]);
    reportedUserId = message?.sender_id ?? null;
  }

  const row = await one<{ id: string }>(
    `INSERT INTO reports (reporter_id, target_type, reported_user_id, message_id, conversation_id,
                          category, reason, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.reporterId,
      input.targetType,
      reportedUserId,
      input.messageId ?? null,
      input.conversationId ?? null,
      input.category,
      input.reason.slice(0, 2000),
      JSON.stringify(
        input.evidence
          ? { excerpt: input.evidence.excerpt?.slice(0, 4000) ?? null, capturedAt: input.evidence.capturedAt ?? null }
          : {},
      ),
    ],
  );
  return { id: row!.id };
}

export interface ModerationAction {
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  note?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAdminAction(action: ModerationAction): Promise<void> {
  await query(
    `INSERT INTO admin_actions (admin_id, action, target_type, target_id, note, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      action.adminId,
      action.action,
      action.targetType,
      action.targetId,
      action.note ?? null,
      JSON.stringify(action.metadata ?? {}),
    ],
  );
}

export type AccountAction = 'suspend' | 'ban' | 'restore';

export async function applyAccountAction(
  adminId: string,
  targetUserId: string,
  action: AccountAction,
  options: { days?: number; note?: string } = {},
): Promise<void> {
  const target = await one<{ id: string; role: string }>('SELECT id, role FROM users WHERE id = $1', [targetUserId]);
  if (!target) throw notFound('That account does not exist.');
  if (target.role === 'admin' && action !== 'restore') {
    throw badRequest('Administrator accounts cannot be suspended or banned from this screen.');
  }

  if (action === 'suspend') {
    const until = options.days ? new Date(Date.now() + options.days * 86_400_000) : null;
    await query(
      `UPDATE users SET status = 'suspended', suspended_until = $2, moderation_note = $3, updated_at = now()
        WHERE id = $1`,
      [targetUserId, until, options.note ?? null],
    );
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetUserId]);
    await disconnectUserSockets(targetUserId);
    await createNotification(targetUserId, {
      type: 'moderation',
      title: 'Your account has been suspended',
      body: options.note ?? 'Your account was suspended for breaking the community rules.',
      data: { until: until?.toISOString() ?? null },
    });
  } else if (action === 'ban') {
    await query(
      `UPDATE users SET status = 'banned', suspended_until = NULL, moderation_note = $2, updated_at = now()
        WHERE id = $1`,
      [targetUserId, options.note ?? null],
    );
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetUserId]);
    await disconnectUserSockets(targetUserId);
  } else {
    await query(
      `UPDATE users SET status = 'active', suspended_until = NULL, moderation_note = $2,
              failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [targetUserId, options.note ?? null],
    );
    await createNotification(targetUserId, {
      type: 'moderation',
      title: 'Your account has been restored',
      body: 'You can use your account normally again.',
    });
  }

  await recordAdminAction({
    adminId,
    action: `account.${action}`,
    targetType: 'user',
    targetId: targetUserId,
    note: options.note,
    metadata: { days: options.days ?? null },
  });
}
