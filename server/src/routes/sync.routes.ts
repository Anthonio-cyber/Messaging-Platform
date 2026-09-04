import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseQuery } from '../lib/http.js';
import { many, one } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { getMessageForViewer, type MessageDto } from '../services/message.service.js';
import { listNotifications } from '../services/notification.service.js';

export const syncRouter: Router = Router();
syncRouter.use(requireAuth());

/**
 * Catch-up endpoint for clients that cannot hold a WebSocket.
 *
 * Serverless platforms (Vercel among them) cannot keep a socket open, so the browser falls
 * back to polling this. It returns everything addressed to the caller that changed since
 * `since`, in the same shape the socket events carry, so the client can feed both transports
 * through one set of handlers.
 *
 * The window is deliberately small and every row is scoped to the caller's own membership.
 */
syncRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { since } = parseQuery(
      z.object({ since: z.string().datetime().optional() }),
      req.query,
    );
    const userId = req.auth!.user.id;
    // First poll of a session: look back far enough to be useful, not far enough to be heavy.
    const cursor = since ?? new Date(Date.now() - 60_000).toISOString();
    const now = new Date().toISOString();

    // Messages the caller can see that were created, edited, deleted, reacted to, or had
    // their read state changed since the cursor.
    const changed = await many<{ id: string; conversation_id: string }>(
      // created_at is selected because DISTINCT requires every ORDER BY expression to appear
      // in the select list.
      `SELECT DISTINCT m.id, m.conversation_id, m.created_at
         FROM messages m
         JOIN conversation_members cm
           ON cm.conversation_id = m.conversation_id
          AND cm.user_id = $1
          AND cm.left_at IS NULL
        WHERE m.created_at > $2::timestamptz
           OR m.edited_at > $2::timestamptz
           OR m.deleted_at > $2::timestamptz
           OR EXISTS (
                SELECT 1 FROM message_reactions r
                 WHERE r.message_id = m.id AND r.created_at > $2::timestamptz)
           OR EXISTS (
                SELECT 1 FROM message_status s
                 WHERE s.message_id = m.id
                   AND (s.read_at > $2::timestamptz OR s.delivered_at > $2::timestamptz))
        ORDER BY m.created_at
        LIMIT 200`,
      [userId, cursor],
    );

    const messages: Array<{ conversationId: string; message: MessageDto }> = [];
    const deleted: Array<{ conversationId: string; messageId: string }> = [];

    for (const row of changed) {
      const message = await getMessageForViewer(row.id, userId);
      if (!message) continue;
      if (message.deletedAt) deleted.push({ conversationId: row.conversation_id, messageId: row.id });
      else messages.push({ conversationId: row.conversation_id, message });
    }

    const notifications = (await listNotifications(userId, 20)).filter(
      (notification) => notification.createdAt > cursor,
    );

    // A cheap fingerprint of the caller's conversation list: when it moves, the client
    // refetches the sidebar rather than this endpoint duplicating that whole query.
    const summary = await one<{
      conversation_revision: string | null;
      membership_revision: string | null;
      pending_requests: number;
    }>(
      `SELECT
         (SELECT max(c.updated_at)::text FROM conversations c
            JOIN conversation_members cm ON cm.conversation_id = c.id
           WHERE cm.user_id = $1 AND cm.left_at IS NULL) AS conversation_revision,
         (SELECT max(cm.joined_at)::text FROM conversation_members cm
           WHERE cm.user_id = $1) AS membership_revision,
         (SELECT count(*)::int FROM message_requests
           WHERE recipient_id = $1 AND status = 'pending') AS pending_requests`,
      [userId],
    );

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      now,
      messages,
      deleted,
      notifications,
      pendingRequests: summary?.pending_requests ?? 0,
      revision: `${summary?.conversation_revision ?? ''}|${summary?.membership_revision ?? ''}`,
    });
  }),
);
