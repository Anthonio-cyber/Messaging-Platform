import { many, one, query, transaction } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { addContactEdge, avatarUrl, blockState } from './user.service.js';
import { createNotification } from './notification.service.js';
import { emitToUser } from '../realtime/emitter.js';

export const MAX_PENDING_MESSAGES = 3;

export interface MessageRequestDto {
  id: string;
  conversationId: string;
  status: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  respondedAt: string | null;
  counterpart: {
    id: string;
    username: string;
    customAddress: string;
    displayName: string;
    avatarUrl: string | null;
    publicKey: string | null;
  };
}

export async function createRequest(
  senderId: string,
  recipientId: string,
  conversationId: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await one<{ id: string; status: string }>(
    `SELECT id, status::text AS status FROM message_requests
      WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'`,
    [senderId, recipientId],
  );
  if (existing) return { id: existing.id, created: false };

  // A previously declined request may be retried once, but never after a block.
  const blocked = await one(
    `SELECT 1 FROM message_requests
      WHERE sender_id = $1 AND recipient_id = $2 AND status = 'blocked'`,
    [senderId, recipientId],
  );
  if (blocked) throw forbidden('This person is not accepting messages from you.');

  const row = await one<{ id: string }>(
    `INSERT INTO message_requests (sender_id, recipient_id, conversation_id) VALUES ($1,$2,$3) RETURNING id`,
    [senderId, recipientId, conversationId],
  );
  return { id: row!.id, created: true };
}

/** Caps how much an unaccepted sender can push into someone's request inbox. */
export async function countPendingMessages(conversationId: string, senderId: string): Promise<number> {
  const row = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND deleted_at IS NULL',
    [conversationId, senderId],
  );
  return row?.count ?? 0;
}

export async function listRequests(
  userId: string,
  direction: 'incoming' | 'outgoing',
): Promise<MessageRequestDto[]> {
  const isIncoming = direction === 'incoming';
  const rows = await many<{
    id: string;
    conversation_id: string;
    status: string;
    created_at: Date;
    responded_at: Date | null;
    other_id: string;
    username: string;
    custom_address: string;
    display_name: string;
    avatar_key: string | null;
    public_key: string | null;
  }>(
    `SELECT r.id, r.conversation_id, r.status::text AS status, r.created_at, r.responded_at,
            u.id AS other_id, u.username, u.custom_address, u.display_name, u.avatar_key, u.public_key
       FROM message_requests r
       JOIN users u ON u.id = ${isIncoming ? 'r.sender_id' : 'r.recipient_id'}
      WHERE ${isIncoming ? 'r.recipient_id' : 'r.sender_id'} = $1
        AND r.status = 'pending'
        AND u.deleted_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT 100`,
    [userId],
  );

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    status: r.status,
    direction,
    createdAt: new Date(r.created_at).toISOString(),
    respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null,
    counterpart: {
      id: r.other_id,
      username: r.username,
      customAddress: r.custom_address,
      displayName: r.display_name,
      avatarUrl: avatarUrl(r.avatar_key),
      publicKey: r.public_key,
    },
  }));
}

export async function countIncoming(userId: string): Promise<number> {
  const row = await one<{ count: number }>(
    "SELECT count(*)::int AS count FROM message_requests WHERE recipient_id = $1 AND status = 'pending'",
    [userId],
  );
  return row?.count ?? 0;
}

export type RequestDecision = 'accepted' | 'declined' | 'blocked';

/**
 * Resolves a pending request. Accepting activates the recipient's membership and creates the
 * mutual contact edge; declining leaves the thread dormant; blocking also records a block so
 * the sender cannot try again.
 */
export async function respondToRequest(
  requestId: string,
  recipientId: string,
  decision: RequestDecision,
): Promise<{ conversationId: string; senderId: string }> {
  const request = await one<{ id: string; sender_id: string; recipient_id: string; conversation_id: string }>(
    `SELECT id, sender_id, recipient_id, conversation_id FROM message_requests
      WHERE id = $1 AND status = 'pending'`,
    [requestId],
  );
  if (!request) throw notFound('That request is no longer pending.');
  if (request.recipient_id !== recipientId) throw forbidden('This request is not addressed to you.');

  await transaction(async (client) => {
    await client.query('UPDATE message_requests SET status = $2, responded_at = now() WHERE id = $1', [
      requestId,
      decision,
    ]);

    if (decision === 'accepted') {
      await client.query(
        `UPDATE conversation_members SET is_active = TRUE, left_at = NULL
          WHERE conversation_id = $1 AND user_id = $2`,
        [request.conversation_id, recipientId],
      );
    }

    if (decision === 'blocked') {
      await client.query(
        'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [recipientId, request.sender_id],
      );
      await client.query(
        `UPDATE conversation_members SET left_at = now(), is_active = FALSE
          WHERE conversation_id = $1 AND user_id = $2`,
        [request.conversation_id, recipientId],
      );
    }
  });

  if (decision === 'accepted') {
    await addContactEdge(recipientId, request.sender_id);
    await createNotification(request.sender_id, {
      type: 'request_accepted',
      title: 'Message request accepted',
      body: 'You can now message each other.',
      data: { conversationId: request.conversation_id, userId: recipientId },
    });
    emitToUser(request.sender_id, 'request:accepted', {
      requestId,
      conversationId: request.conversation_id,
    });
  }

  return { conversationId: request.conversation_id, senderId: request.sender_id };
}

export async function notifyNewRequest(
  recipientId: string,
  senderDisplayName: string,
  senderAddress: string,
  requestId: string,
  conversationId: string,
): Promise<void> {
  await createNotification(recipientId, {
    type: 'message_request',
    title: 'New message request',
    body: `${senderDisplayName} (${senderAddress}) wants to message you.`,
    data: { requestId, conversationId },
  });
  emitToUser(recipientId, 'request:new', { requestId, conversationId });
}

export async function withdrawRequest(requestId: string, senderId: string): Promise<void> {
  const result = await query(
    `UPDATE message_requests SET status = 'declined', responded_at = now()
      WHERE id = $1 AND sender_id = $2 AND status = 'pending'`,
    [requestId, senderId],
  );
  if ((result.rowCount ?? 0) === 0) throw notFound('That request is no longer pending.');
}

export async function assertCanInitiate(senderId: string, recipientId: string): Promise<void> {
  const blocks = await blockState(senderId, recipientId);
  if (blocks.either) throw forbidden('This person is not accepting messages.');
  if (senderId === recipientId) throw badRequest('You cannot message yourself.');
}
