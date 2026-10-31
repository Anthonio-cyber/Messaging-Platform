import { many, one, query, transaction } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { avatarUrl } from './user.service.js';
import {
  listKeyRecipients,
  requireMembership,
  touchConversation,
  type ConversationRow,
  type MembershipRow,
} from './conversation.service.js';

export const MAX_CIPHERTEXT_BYTES = 64 * 1024;

export interface WrappedKeyInput {
  userId: string;
  wrappedKey: string;
}

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  ciphertext: string;
  nonce: string;
  kind?: 'text' | 'attachment';
  keys: WrappedKeyInput[];
  replyToId?: string | null;
  forwardedFrom?: string | null;
  attachmentIds?: string[];
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string | null;
  kind: string;
  ciphertext: string;
  nonce: string;
  wrappedKey: string | null;
  systemPayload: Record<string, unknown> | null;
  replyToId: string | null;
  forwardedFrom: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedForAll: boolean;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  attachments: Array<{ id: string; byteSize: number; mimeType: string; category: string }>;
  deliveredCount: number;
  readCount: number;
  recipientCount: number;
  readAt: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  kind: string;
  ciphertext: string;
  nonce: string;
  system_payload: Record<string, unknown> | null;
  reply_to_id: string | null;
  forwarded_from: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_for_all: boolean;
  wrapped_key: string | null;
  read_at: Date | null;
  delivered_count: number;
  read_count: number;
  recipient_count: number;
  reactions: Array<{ emoji: string; user_id: string }> | null;
  attachments: Array<{ id: string; byte_size: number; mime_type: string; category: string }> | null;
}

/**
 * Selects a message with everything the viewer is entitled to: their own sealed copy of the
 * message key, their read state, aggregate delivery counts and reactions. The key join is
 * what enforces read access at the row level — no key, no plaintext.
 */
const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.kind, m.ciphertext, m.nonce, m.system_payload,
         m.reply_to_id, m.forwarded_from, m.created_at, m.edited_at, m.deleted_at, m.deleted_for_all,
         mk.wrapped_key,
         ms.read_at,
         (SELECT count(*)::int FROM message_status s
           WHERE s.message_id = m.id AND s.user_id <> COALESCE(m.sender_id, s.user_id) AND s.delivered_at IS NOT NULL) AS delivered_count,
         (SELECT count(*)::int FROM message_status s
           WHERE s.message_id = m.id AND s.user_id <> COALESCE(m.sender_id, s.user_id) AND s.read_at IS NOT NULL) AS read_count,
         (SELECT count(*)::int FROM message_status s
           WHERE s.message_id = m.id AND s.user_id <> COALESCE(m.sender_id, s.user_id)) AS recipient_count,
         (SELECT coalesce(json_agg(json_build_object('emoji', r.emoji, 'user_id', r.user_id)), '[]'::json)
            FROM message_reactions r WHERE r.message_id = m.id) AS reactions,
         (SELECT coalesce(json_agg(json_build_object(
                   'id', a.id, 'byte_size', a.byte_size, 'mime_type', a.mime_type, 'category', a.category)), '[]'::json)
            FROM attachments a WHERE a.message_id = m.id) AS attachments
    FROM messages m
    LEFT JOIN message_keys mk ON mk.message_id = m.id AND mk.user_id = $1
    LEFT JOIN message_status ms ON ms.message_id = m.id AND ms.user_id = $1
`;

function toDto(row: MessageRow, viewerId: string): MessageDto {
  const reactionRows = row.reactions ?? [];
  const grouped = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactionRows) {
    const entry = grouped.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (r.user_id === viewerId) entry.mine = true;
    grouped.set(r.emoji, entry);
  }

  const removed = row.deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    // A deleted message keeps its row (replies point at it) but sheds its payload entirely.
    ciphertext: removed ? '' : row.ciphertext,
    nonce: removed ? '' : row.nonce,
    wrappedKey: removed ? null : row.wrapped_key,
    systemPayload: row.system_payload,
    replyToId: row.reply_to_id,
    forwardedFrom: row.forwarded_from,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    deletedForAll: row.deleted_for_all,
    reactions: [...grouped.entries()].map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })),
    attachments: removed
      ? []
      : (row.attachments ?? []).map((a) => ({
          id: a.id,
          byteSize: Number(a.byte_size),
          mimeType: a.mime_type,
          category: a.category,
        })),
    deliveredCount: Number(row.delivered_count ?? 0),
    readCount: Number(row.read_count ?? 0),
    recipientCount: Number(row.recipient_count ?? 0),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
  };
}

export async function getMessageForViewer(messageId: string, viewerId: string): Promise<MessageDto | null> {
  const row = await one<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $2`, [viewerId, messageId]);
  return row ? toDto(row, viewerId) : null;
}

/**
 * Persists a message plus one sealed key per recipient and a delivery-status row per member.
 * The whole thing is one transaction: a message nobody holds a key for would be unreadable
 * forever, so partial writes are not acceptable.
 */
export async function sendMessage(input: SendMessageInput): Promise<MessageDto> {
  if (Buffer.byteLength(input.ciphertext, 'utf8') > MAX_CIPHERTEXT_BYTES) {
    throw badRequest('That message is too large to send.');
  }

  const recipients = await listKeyRecipients(input.conversationId);
  const recipientIds = new Set(recipients.map((r) => r.userId));
  const providedIds = new Set(input.keys.map((k) => k.userId));

  // Keys may not be minted for outsiders, and every current member must get one.
  for (const key of input.keys) {
    if (!recipientIds.has(key.userId)) {
      throw forbidden('Cannot address a message key to someone outside this conversation.');
    }
  }
  for (const recipient of recipients) {
    if (recipient.publicKey && !providedIds.has(recipient.userId)) {
      throw badRequest('Message keys are missing for some members. Reload the conversation and try again.');
    }
  }

  if (input.replyToId) {
    const parent = await one<{ id: string }>(
      'SELECT id FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
      [input.replyToId, input.conversationId],
    );
    if (!parent) throw badRequest('The message you are replying to is no longer available.');
  }

  const messageId = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, sender_id, kind, ciphertext, nonce, reply_to_id, forwarded_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.conversationId,
        input.senderId,
        input.kind ?? 'text',
        input.ciphertext,
        input.nonce,
        input.replyToId ?? null,
        input.forwardedFrom ?? null,
      ],
    );
    const id = inserted.rows[0]!.id;

    for (const key of input.keys) {
      await client.query(
        'INSERT INTO message_keys (message_id, user_id, wrapped_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, key.userId, key.wrappedKey],
      );
    }

    for (const recipient of recipients) {
      const isSender = recipient.userId === input.senderId;
      await client.query(
        `INSERT INTO message_status (message_id, user_id, delivered_at, read_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [id, recipient.userId, isSender ? new Date() : null, isSender ? new Date() : null],
      );
    }

    if (input.attachmentIds?.length) {
      // Claim only this uploader's unattached files in this conversation.
      await client.query(
        `UPDATE attachments SET message_id = $1
          WHERE id = ANY($2::uuid[]) AND uploader_id = $3 AND conversation_id = $4 AND message_id IS NULL`,
        [id, input.attachmentIds, input.senderId, input.conversationId],
      );
    }

    await client.query(
      'UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1',
      [input.conversationId],
    );
    // A new message un-archives the thread and clears any manual "unread" flag for the sender.
    await client.query(
      `UPDATE conversation_members SET archived_at = NULL
        WHERE conversation_id = $1 AND archived_at IS NOT NULL`,
      [input.conversationId],
    );
    await client.query(
      `UPDATE conversation_members SET last_read_message_id = $2, manually_unread = FALSE
        WHERE conversation_id = $1 AND user_id = $3`,
      [input.conversationId, id, input.senderId],
    );
    return id;
  });

  const dto = await getMessageForViewer(messageId, input.senderId);
  if (!dto) throw notFound('Message could not be loaded after sending.');
  return dto;
}

export async function postSystemMessage(
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, kind, ciphertext, nonce, system_payload)
       VALUES ($1, NULL, 'system', '', '', $2)`,
      [conversationId, JSON.stringify(payload)],
    );
    await client.query('UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [
      conversationId,
    ]);
  });
}

export interface MessagePage {
  messages: MessageDto[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listMessages(
  conversationId: string,
  viewerId: string,
  options: { limit: number; before?: string | null; after?: string | null },
): Promise<MessagePage> {
  const limit = Math.min(Math.max(options.limit, 1), 100);

  if (options.after) {
    const rows = await many<MessageRow>(
      `${MESSAGE_SELECT}
        WHERE m.conversation_id = $2
          AND m.created_at > (SELECT created_at FROM messages WHERE id = $3)
        ORDER BY m.created_at ASC
        LIMIT $4`,
      [viewerId, conversationId, options.after, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      messages: page.map((r) => toDto(r, viewerId)),
      hasMore: rows.length > limit,
      nextCursor: page.length ? page[page.length - 1]!.id : null,
    };
  }

  const rows = await many<MessageRow>(
    `${MESSAGE_SELECT}
      WHERE m.conversation_id = $2
        AND ($3::uuid IS NULL OR m.created_at < (SELECT created_at FROM messages WHERE id = $3::uuid))
      ORDER BY m.created_at DESC
      LIMIT $4`,
    [viewerId, conversationId, options.before ?? null, limit + 1],
  );

  const page = rows.slice(0, limit);
  return {
    // Returned oldest-first so the client can append without re-sorting.
    messages: page.map((r) => toDto(r, viewerId)).reverse(),
    hasMore: rows.length > limit,
    nextCursor: page.length ? page[page.length - 1]!.id : null,
  };
}

export async function editMessage(
  messageId: string,
  editorId: string,
  ciphertext: string,
  nonce: string,
  keys: WrappedKeyInput[],
): Promise<MessageDto> {
  const row = await one<{ id: string; sender_id: string | null; conversation_id: string; deleted_at: Date | null }>(
    'SELECT id, sender_id, conversation_id, deleted_at FROM messages WHERE id = $1',
    [messageId],
  );
  if (!row) throw notFound('That message no longer exists.');
  if (row.sender_id !== editorId) throw forbidden('You can only edit your own messages.');
  if (row.deleted_at) throw badRequest('You cannot edit a deleted message.');
  if (Buffer.byteLength(ciphertext, 'utf8') > MAX_CIPHERTEXT_BYTES) {
    throw badRequest('That message is too large.');
  }

  const recipients = new Set((await listKeyRecipients(row.conversation_id)).map((r) => r.userId));
  for (const key of keys) {
    if (!recipients.has(key.userId)) throw forbidden('Cannot address a message key outside this conversation.');
  }

  await transaction(async (client) => {
    await client.query(
      'UPDATE messages SET ciphertext = $2, nonce = $3, edited_at = now() WHERE id = $1',
      [messageId, ciphertext, nonce],
    );
    // Re-encryption produces a new message key, so every sealed copy is replaced.
    await client.query('DELETE FROM message_keys WHERE message_id = $1', [messageId]);
    for (const key of keys) {
      await client.query('INSERT INTO message_keys (message_id, user_id, wrapped_key) VALUES ($1,$2,$3)', [
        messageId,
        key.userId,
        key.wrappedKey,
      ]);
    }
  });

  const dto = await getMessageForViewer(messageId, editorId);
  return dto!;
}

export async function deleteMessage(
  messageId: string,
  actorId: string,
  forEveryone: boolean,
): Promise<{ conversationId: string }> {
  const row = await one<{ id: string; sender_id: string | null; conversation_id: string }>(
    'SELECT id, sender_id, conversation_id FROM messages WHERE id = $1 AND deleted_at IS NULL',
    [messageId],
  );
  if (!row) throw notFound('That message no longer exists.');

  if (forEveryone) {
    if (row.sender_id !== actorId) {
      // Group admins may also remove other people's messages.
      const membership = await one<{ role: string }>(
        'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
        [row.conversation_id, actorId],
      );
      if (!membership || membership.role === 'member') {
        throw forbidden('You can only delete your own messages.');
      }
    }
    await transaction(async (client) => {
      await client.query(
        'UPDATE messages SET deleted_at = now(), deleted_for_all = TRUE, ciphertext = \'\', nonce = \'\' WHERE id = $1',
        [messageId],
      );
      // Dropping the keys makes the ciphertext unrecoverable even from a database backup.
      await client.query('DELETE FROM message_keys WHERE message_id = $1', [messageId]);
    });
  } else {
    // "Delete for me" only removes this reader's ability to decrypt it.
    await query('DELETE FROM message_keys WHERE message_id = $1 AND user_id = $2', [messageId, actorId]);
  }

  return { conversationId: row.conversation_id };
}

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<{ conversationId: string; added: boolean }> {
  const row = await one<{ conversation_id: string }>(
    'SELECT conversation_id FROM messages WHERE id = $1 AND deleted_at IS NULL',
    [messageId],
  );
  if (!row) throw notFound('That message no longer exists.');
  await requireMembership(row.conversation_id, userId);

  const deleted = await query(
    'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, userId, emoji],
  );
  if ((deleted.rowCount ?? 0) > 0) return { conversationId: row.conversation_id, added: false };

  await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)', [
    messageId,
    userId,
    emoji,
  ]);
  return { conversationId: row.conversation_id, added: true };
}

export async function markDelivered(userId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  await query(
    `UPDATE message_status SET delivered_at = now()
      WHERE user_id = $1 AND message_id = ANY($2::uuid[]) AND delivered_at IS NULL`,
    [userId, messageIds],
  );
}

export interface ReadReceiptResult {
  conversationId: string;
  readerId: string;
  messageIds: string[];
  lastReadMessageId: string | null;
  shareReceipts: boolean;
}

/**
 * Marks everything up to `upToMessageId` as read for this member. When the reader has read
 * receipts switched off, their read timestamps are still stored (they drive their own unread
 * badge) but never broadcast to anyone else.
 */
export async function markRead(
  conversationId: string,
  readerId: string,
  upToMessageId: string,
  shareReceipts: boolean,
): Promise<ReadReceiptResult> {
  const updated = await many<{ message_id: string }>(
    `UPDATE message_status ms SET read_at = now(), delivered_at = COALESCE(ms.delivered_at, now())
       FROM messages m
      WHERE ms.message_id = m.id
        AND ms.user_id = $1
        AND m.conversation_id = $2
        AND ms.read_at IS NULL
        AND m.created_at <= (SELECT created_at FROM messages WHERE id = $3)
      RETURNING ms.message_id`,
    [readerId, conversationId, upToMessageId],
  );

  await query(
    `UPDATE conversation_members
        SET last_read_message_id = $3, manually_unread = FALSE
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, readerId, upToMessageId],
  );

  return {
    conversationId,
    readerId,
    messageIds: updated.map((r) => r.message_id),
    lastReadMessageId: upToMessageId,
    shareReceipts,
  };
}

export async function unreadCount(conversationId: string, userId: string): Promise<number> {
  const row = await one<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM message_status ms
       JOIN messages m ON m.id = ms.message_id
      WHERE ms.user_id = $1 AND m.conversation_id = $2 AND ms.read_at IS NULL AND m.deleted_at IS NULL`,
    [userId, conversationId],
  );
  return row?.count ?? 0;
}

export async function pinMessage(
  conversationId: string,
  messageId: string,
  userId: string,
): Promise<{ pinned: boolean }> {
  const message = await one('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL', [
    messageId,
    conversationId,
  ]);
  if (!message) throw notFound('That message no longer exists.');

  const removed = await query('DELETE FROM pinned_messages WHERE conversation_id = $1 AND message_id = $2', [
    conversationId,
    messageId,
  ]);
  if ((removed.rowCount ?? 0) > 0) return { pinned: false };

  await query(
    'INSERT INTO pinned_messages (conversation_id, message_id, pinned_by) VALUES ($1,$2,$3)',
    [conversationId, messageId, userId],
  );
  return { pinned: true };
}

export async function listPinned(conversationId: string, viewerId: string): Promise<MessageDto[]> {
  const rows = await many<MessageRow>(
    `${MESSAGE_SELECT}
       JOIN pinned_messages pm ON pm.message_id = m.id
      WHERE m.conversation_id = $2 AND m.deleted_at IS NULL
      ORDER BY pm.pinned_at DESC LIMIT 50`,
    [viewerId, conversationId],
  );
  return rows.map((r) => toDto(r, viewerId));
}

export interface ConversationSummary {
  id: string;
  type: string;
  title: string | null;
  description: string;
  avatarUrl: string | null;
  isE2ee: boolean;
  permissions: Record<string, string>;
  myRole: string;
  isActive: boolean;
  mutedUntil: string | null;
  archivedAt: string | null;
  pinnedAt: string | null;
  manuallyUnread: boolean;
  unreadCount: number;
  memberCount: number;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessage: MessageDto | null;
  otherMember: {
    id: string;
    username: string;
    customAddress: string;
    displayName: string;
    avatarUrl: string | null;
    publicKey: string | null;
    presence: string | null;
  } | null;
  pendingRequest: { id: string; direction: 'incoming' | 'outgoing'; status: string } | null;
}

/**
 * The conversation list. Everything the sidebar needs in one query set: unread counts, the
 * last message (still encrypted — the client decrypts it), and, for direct chats, the other
 * person's card. Pending inbound requests are excluded; they live on the Requests screen.
 */
export async function listConversations(
  viewerId: string,
  options: { includeArchived?: boolean } = {},
): Promise<ConversationSummary[]> {
  const rows = await many<{
    id: string;
    type: string;
    title: string | null;
    description: string;
    avatar_key: string | null;
    is_e2ee: boolean;
    permissions: Record<string, string>;
    role: string;
    is_active: boolean;
    muted_until: Date | null;
    archived_at: Date | null;
    pinned_at: Date | null;
    manually_unread: boolean;
    created_at: Date;
    last_message_at: Date | null;
    unread_count: number;
    member_count: number;
    last_message_id: string | null;
    other_id: string | null;
    other_username: string | null;
    other_address: string | null;
    other_display_name: string | null;
    other_avatar_key: string | null;
    other_public_key: string | null;
    other_presence: string | null;
    other_presence_visible: boolean | null;
    request_id: string | null;
    request_status: string | null;
    request_sender: string | null;
  }>(
    `WITH mine AS (
       SELECT cm.*, c.type, c.title, c.description, c.avatar_key, c.is_e2ee, c.permissions,
              c.created_at, c.last_message_at
         FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = $1 AND cm.left_at IS NULL AND cm.is_active = TRUE AND c.deleted_at IS NULL
     )
     SELECT mine.conversation_id AS id, mine.type, mine.title, mine.description, mine.avatar_key,
            mine.is_e2ee, mine.permissions, mine.role, mine.is_active, mine.muted_until,
            mine.archived_at, mine.pinned_at, mine.manually_unread, mine.created_at, mine.last_message_at,
            (SELECT count(*)::int FROM message_status ms
               JOIN messages m2 ON m2.id = ms.message_id
              WHERE ms.user_id = $1 AND m2.conversation_id = mine.conversation_id
                AND ms.read_at IS NULL AND m2.deleted_at IS NULL) AS unread_count,
            (SELECT count(*)::int FROM conversation_members cm2
              WHERE cm2.conversation_id = mine.conversation_id AND cm2.left_at IS NULL) AS member_count,
            (SELECT m3.id FROM messages m3
              WHERE m3.conversation_id = mine.conversation_id
              ORDER BY m3.created_at DESC LIMIT 1) AS last_message_id,
            other.id AS other_id, other.username AS other_username, other.custom_address AS other_address,
            other.display_name AS other_display_name, other.avatar_key AS other_avatar_key,
            other.public_key AS other_public_key, other.presence AS other_presence,
            (op.online_status_visible = 'everyone'
              OR (op.online_status_visible = 'contacts'
                  AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.user_id = $1 AND ct.contact_id = other.id))
            ) AS other_presence_visible,
            mr.id AS request_id, mr.status::text AS request_status, mr.sender_id AS request_sender
       FROM mine
       LEFT JOIN LATERAL (
         SELECT u.* FROM conversation_members cm3
           JOIN users u ON u.id = cm3.user_id
          WHERE cm3.conversation_id = mine.conversation_id AND cm3.user_id <> $1
          LIMIT 1
       ) other ON mine.type = 'direct'
       LEFT JOIN privacy_settings op ON op.user_id = other.id
       LEFT JOIN LATERAL (
         SELECT r.id, r.status, r.sender_id FROM message_requests r
          WHERE r.conversation_id = mine.conversation_id AND r.status = 'pending'
          ORDER BY r.created_at DESC LIMIT 1
       ) mr ON TRUE
      WHERE ($2::boolean OR mine.archived_at IS NULL)
      ORDER BY mine.pinned_at DESC NULLS LAST, mine.last_message_at DESC NULLS LAST, mine.created_at DESC`,
    [viewerId, options.includeArchived ?? false],
  );

  const lastMessageIds = rows.map((r) => r.last_message_id).filter((id): id is string => id !== null);
  const lastMessages = new Map<string, MessageDto>();
  if (lastMessageIds.length > 0) {
    const messageRows = await many<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = ANY($2::uuid[])`, [
      viewerId,
      lastMessageIds,
    ]);
    for (const row of messageRows) lastMessages.set(row.id, toDto(row, viewerId));
  }

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    description: r.description,
    avatarUrl: avatarUrl(r.avatar_key),
    isE2ee: r.is_e2ee,
    permissions: r.permissions,
    myRole: r.role,
    isActive: r.is_active,
    mutedUntil: r.muted_until ? new Date(r.muted_until).toISOString() : null,
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    pinnedAt: r.pinned_at ? new Date(r.pinned_at).toISOString() : null,
    manuallyUnread: r.manually_unread,
    unreadCount: Number(r.unread_count),
    memberCount: Number(r.member_count),
    createdAt: new Date(r.created_at).toISOString(),
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    lastMessage: r.last_message_id ? lastMessages.get(r.last_message_id) ?? null : null,
    otherMember: r.other_id
      ? {
          id: r.other_id,
          username: r.other_username!,
          customAddress: r.other_address!,
          displayName: r.other_display_name!,
          avatarUrl: avatarUrl(r.other_avatar_key),
          publicKey: r.other_public_key,
          presence: r.other_presence_visible ? r.other_presence : null,
        }
      : null,
    pendingRequest: r.request_id
      ? {
          id: r.request_id,
          direction: r.request_sender === viewerId ? 'outgoing' : 'incoming',
          status: r.request_status!,
        }
      : null,
  }));
}

export async function setConversationFlags(
  conversationId: string,
  userId: string,
  flags: { muteUntil?: string | null; archived?: boolean; pinned?: boolean; unread?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [conversationId, userId];

  if (flags.muteUntil !== undefined) {
    params.push(flags.muteUntil);
    sets.push(`muted_until = $${params.length}::timestamptz`);
  }
  if (flags.archived !== undefined) sets.push(`archived_at = ${flags.archived ? 'now()' : 'NULL'}`);
  if (flags.pinned !== undefined) sets.push(`pinned_at = ${flags.pinned ? 'now()' : 'NULL'}`);
  if (flags.unread !== undefined) {
    params.push(flags.unread);
    sets.push(`manually_unread = $${params.length}`);
  }
  if (sets.length === 0) return;

  await query(
    `UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = $1 AND user_id = $2`,
    params,
  );
}

export type { ConversationRow, MembershipRow };
export { requireMembership, touchConversation };
