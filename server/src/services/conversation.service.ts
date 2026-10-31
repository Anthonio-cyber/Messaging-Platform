import type { PoolClient } from 'pg';
import { many, one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { ConversationPermissions, ConversationType, MemberRole } from '../types.js';
import { avatarUrl, blockState, getPrivacy } from './user.service.js';

export interface ConversationRow {
  id: string;
  type: ConversationType;
  title: string | null;
  description: string;
  avatar_key: string | null;
  created_by: string | null;
  is_e2ee: boolean;
  permissions: ConversationPermissions;
  direct_key: string | null;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface MembershipRow {
  conversation_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: Date;
  left_at: Date | null;
  invited_by: string | null;
  muted_until: Date | null;
  archived_at: Date | null;
  pinned_at: Date | null;
  is_active: boolean;
  last_read_message_id: string | null;
  manually_unread: boolean;
}

export function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join(':');
}

/**
 * The single authorisation gate for every conversation-scoped route. A caller that is not a
 * live member gets 404, not 403, so conversation ids cannot be probed for existence.
 */
export async function requireMembership(
  conversationId: string,
  userId: string,
  options: { allowPending?: boolean; allowLeft?: boolean } = {},
): Promise<{ conversation: ConversationRow; membership: MembershipRow }> {
  const conversation = await one<ConversationRow>(
    'SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL',
    [conversationId],
  );
  if (!conversation) throw notFound('That conversation does not exist.');

  const membership = await one<MembershipRow>(
    'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  if (!membership) throw notFound('That conversation does not exist.');
  if (membership.left_at && !options.allowLeft) throw notFound('That conversation does not exist.');
  if (!membership.is_active && !options.allowPending) {
    throw forbidden('This conversation is not active yet. Accept the message request first.');
  }

  return { conversation, membership };
}

export async function listMemberIds(conversationId: string, includePending = true): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    `SELECT user_id FROM conversation_members
      WHERE conversation_id = $1 AND left_at IS NULL ${includePending ? '' : 'AND is_active = TRUE'}`,
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

export interface MemberSummary {
  userId: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  publicKey: string | null;
  role: MemberRole;
  joinedAt: string;
  isActive: boolean;
  presence: string | null;
}

export async function listMembers(conversationId: string): Promise<MemberSummary[]> {
  const rows = await many<{
    user_id: string;
    username: string;
    custom_address: string;
    display_name: string;
    avatar_key: string | null;
    public_key: string | null;
    role: MemberRole;
    joined_at: Date;
    is_active: boolean;
    presence: string;
  }>(
    `SELECT cm.user_id, u.username, u.custom_address, u.display_name, u.avatar_key,
            u.public_key, cm.role, cm.joined_at, cm.is_active, u.presence
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1 AND cm.left_at IS NULL
      ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`,
    [conversationId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    customAddress: r.custom_address,
    displayName: r.display_name,
    avatarUrl: avatarUrl(r.avatar_key),
    publicKey: r.public_key,
    role: r.role,
    joinedAt: new Date(r.joined_at).toISOString(),
    isActive: r.is_active,
    presence: r.presence,
  }));
}

/** Recipients that a new message key must be sealed for. Left/pending members are excluded. */
export async function listKeyRecipients(
  conversationId: string,
): Promise<Array<{ userId: string; publicKey: string | null }>> {
  const rows = await many<{ user_id: string; public_key: string | null }>(
    `SELECT cm.user_id, u.public_key
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND u.deleted_at IS NULL`,
    [conversationId],
  );
  return rows.map((r) => ({ userId: r.user_id, publicKey: r.public_key }));
}

export interface DirectConversationResult {
  conversation: ConversationRow;
  created: boolean;
  requiresRequest: boolean;
}

/**
 * Finds or creates the one direct conversation between two people.
 *
 * Respects the recipient's "who can contact me" setting: `nobody` refuses outright,
 * `approved` creates the conversation with the recipient's membership inactive until they
 * accept the message request, `everyone` activates both sides immediately.
 */
export async function getOrCreateDirectConversation(
  initiatorId: string,
  recipientId: string,
): Promise<DirectConversationResult> {
  if (initiatorId === recipientId) throw badRequest('You cannot start a conversation with yourself.');

  const key = directKeyFor(initiatorId, recipientId);
  const existing = await one<ConversationRow>(
    'SELECT * FROM conversations WHERE direct_key = $1 AND deleted_at IS NULL',
    [key],
  );

  const blocks = await blockState(initiatorId, recipientId);
  if (blocks.viewerBlockedTarget) {
    throw forbidden('You have blocked this person. Unblock them to start a conversation.');
  }
  if (blocks.targetBlockedViewer) {
    // Deliberately indistinguishable from a strict privacy setting.
    throw forbidden('This person is not accepting messages.');
  }

  if (existing) {
    const mine = await one<MembershipRow>(
      'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [existing.id, initiatorId],
    );
    // Rejoin a conversation the initiator previously left.
    if (mine?.left_at) {
      await query(
        'UPDATE conversation_members SET left_at = NULL, is_active = TRUE WHERE conversation_id = $1 AND user_id = $2',
        [existing.id, initiatorId],
      );
    }
    const theirs = await one<MembershipRow>(
      'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [existing.id, recipientId],
    );
    return { conversation: existing, created: false, requiresRequest: !theirs?.is_active };
  }

  const privacy = await getPrivacy(recipientId);
  if (privacy.who_can_contact === 'nobody') {
    throw forbidden('This person is not accepting messages.');
  }
  const requiresRequest = privacy.who_can_contact === 'approved';

  const conversation = await transaction(async (client) => {
    const created = await client.query<ConversationRow>(
      `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', $1, $2) RETURNING *`,
      [key, initiatorId],
    );
    const row = created.rows[0]!;
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, is_active)
       VALUES ($1, $2, 'member', TRUE), ($1, $3, 'member', $4)`,
      [row.id, initiatorId, recipientId, !requiresRequest],
    );
    return row;
  });

  return { conversation, created: true, requiresRequest };
}

export interface CreateGroupInput {
  title: string;
  description?: string;
  memberIds: string[];
  permissions?: Partial<ConversationPermissions>;
}

const DEFAULT_PERMISSIONS: ConversationPermissions = {
  who_can_send: 'everyone',
  who_can_add: 'admins',
  who_can_edit_info: 'admins',
  who_can_invite: 'admins',
};

export const MAX_GROUP_MEMBERS = 256;

export async function createGroup(ownerId: string, input: CreateGroupInput): Promise<ConversationRow> {
  const unique = [...new Set(input.memberIds.filter((id) => id !== ownerId))];
  if (unique.length + 1 > MAX_GROUP_MEMBERS) {
    throw badRequest(`Groups can hold up to ${MAX_GROUP_MEMBERS} people.`);
  }

  // Only people who already accepted you can be dropped into a group without consent.
  for (const memberId of unique) {
    const blocks = await blockState(ownerId, memberId);
    if (blocks.either) throw forbidden('One of the people you selected cannot be added.');
  }

  return transaction(async (client) => {
    const created = await client.query<ConversationRow>(
      `INSERT INTO conversations (type, title, description, created_by, permissions)
       VALUES ('group', $1, $2, $3, $4) RETURNING *`,
      [
        input.title.trim(),
        input.description?.trim() ?? '',
        ownerId,
        JSON.stringify({ ...DEFAULT_PERMISSIONS, ...(input.permissions ?? {}) }),
      ],
    );
    const conversation = created.rows[0]!;
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, is_active) VALUES ($1, $2, 'owner', TRUE)`,
      [conversation.id, ownerId],
    );
    for (const memberId of unique) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, invited_by, is_active)
         VALUES ($1, $2, 'member', $3, TRUE) ON CONFLICT DO NOTHING`,
        [conversation.id, memberId, ownerId],
      );
    }
    return conversation;
  });
}

export function canActOnGroup(
  membership: MembershipRow,
  conversation: ConversationRow,
  capability: keyof ConversationPermissions,
): boolean {
  if (conversation.type !== 'group') return true;
  if (membership.role === 'owner') return true;
  const setting = conversation.permissions?.[capability] ?? 'admins';
  if (setting === 'everyone') return true;
  return membership.role === 'admin';
}

export function assertGroupCapability(
  membership: MembershipRow,
  conversation: ConversationRow,
  capability: keyof ConversationPermissions,
  message: string,
): void {
  if (!canActOnGroup(membership, conversation, capability)) throw forbidden(message);
}

export async function touchConversation(conversationId: string, client?: PoolClient): Promise<void> {
  const sql = 'UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1';
  if (client) await client.query(sql, [conversationId]);
  else await query(sql, [conversationId]);
}

export async function addMembers(
  conversationId: string,
  actorId: string,
  memberIds: string[],
): Promise<string[]> {
  const existing = await listMemberIds(conversationId);
  const toAdd = [...new Set(memberIds)].filter((id) => !existing.includes(id));
  if (toAdd.length === 0) return [];
  if (existing.length + toAdd.length > MAX_GROUP_MEMBERS) {
    throw conflict(`Groups can hold up to ${MAX_GROUP_MEMBERS} people.`);
  }

  await transaction(async (client) => {
    for (const id of toAdd) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role, invited_by, is_active)
         VALUES ($1, $2, 'member', $3, TRUE)
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET left_at = NULL, is_active = TRUE, invited_by = EXCLUDED.invited_by`,
        [conversationId, id, actorId],
      );
    }
  });
  return toAdd;
}

export async function removeMember(conversationId: string, userId: string): Promise<void> {
  await query(
    `UPDATE conversation_members SET left_at = now(), is_active = FALSE
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
}
