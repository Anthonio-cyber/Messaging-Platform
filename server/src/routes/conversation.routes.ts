import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { generateToken } from '../lib/crypto.js';
import { many, one, query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/rateLimit.js';
import {
  addMembers,
  assertGroupCapability,
  createGroup,
  getOrCreateDirectConversation,
  listMembers,
  listMemberIds,
  removeMember,
  requireMembership,
  type ConversationRow,
} from '../services/conversation.service.js';
import { listConversations, postSystemMessage, setConversationFlags, listPinned } from '../services/message.service.js';
import { assertCanInitiate, createRequest, notifyNewRequest } from '../services/request.service.js';
import { avatarUrl, blockState, findUserById, findUserByIdentifier } from '../services/user.service.js';
import { createNotification } from '../services/notification.service.js';
import { emitToUser, emitToUsers, emitToConversation } from '../realtime/emitter.js';

export const conversationRouter: Router = Router();
conversationRouter.use(requireAuth());

const uuid = z.string().uuid();

function serializeConversation(conversation: ConversationRow) {
  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title,
    description: conversation.description,
    avatarUrl: avatarUrl(conversation.avatar_key),
    isE2ee: conversation.is_e2ee,
    permissions: conversation.permissions,
    createdAt: new Date(conversation.created_at).toISOString(),
    lastMessageAt: conversation.last_message_at ? new Date(conversation.last_message_at).toISOString() : null,
  };
}

conversationRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { archived } = parseQuery(
      z.object({ archived: z.enum(['true', 'false']).default('false') }),
      req.query,
    );
    const conversations = await listConversations(req.auth!.user.id, {
      includeArchived: archived === 'true',
    });
    res.json({ conversations });
  }),
);

/**
 * Opens (or reopens) the direct conversation with another person. When their privacy setting
 * requires approval, this also files a message request — the thread stays one-sided until
 * they accept.
 */
conversationRouter.post(
  '/direct',
  limiters.messageRequest,
  asyncRoute(async (req, res) => {
    const { identifier, userId } = parseBody(
      z
        .object({
          identifier: z.string().trim().min(1).max(320).optional(),
          userId: uuid.optional(),
        })
        .refine((v) => v.identifier || v.userId, { message: 'Provide a user id or an identity.' }),
      req.body,
    );

    const me = req.auth!.user;
    const target = userId
      ? await findUserById(userId)
      : await findUserByIdentifier(identifier!);

    if (!target || target.status !== 'active') throw notFound('No account uses that identity.');
    await assertCanInitiate(me.id, target.id);

    const result = await getOrCreateDirectConversation(me.id, target.id);
    let requestId: string | null = null;

    if (result.requiresRequest) {
      const request = await createRequest(me.id, target.id, result.conversation.id);
      requestId = request.id;
      if (request.created) {
        await notifyNewRequest(target.id, me.displayName, me.customAddress, request.id, result.conversation.id);
      }
    } else if (result.created) {
      emitToUser(target.id, 'conversation:new', { conversationId: result.conversation.id });
    }

    res.status(result.created ? 201 : 200).json({
      conversation: serializeConversation(result.conversation),
      members: await listMembers(result.conversation.id),
      requiresRequest: result.requiresRequest,
      requestId,
    });
  }),
);

conversationRouter.post(
  '/groups',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1, 'Give the group a name.').max(80),
        description: z.string().trim().max(500).optional(),
        memberIds: z.array(uuid).max(255).default([]),
        permissions: z
          .object({
            who_can_send: z.enum(['everyone', 'admins']).optional(),
            who_can_add: z.enum(['everyone', 'admins']).optional(),
            who_can_edit_info: z.enum(['everyone', 'admins']).optional(),
            who_can_invite: z.enum(['everyone', 'admins']).optional(),
          })
          .optional(),
      }),
      req.body,
    );

    const conversation = await createGroup(req.auth!.user.id, body);
    const members = await listMembers(conversation.id);

    await postSystemMessage(conversation.id, {
      event: 'group_created',
      actorId: req.auth!.user.id,
      actorName: req.auth!.user.displayName,
      title: body.title,
    });

    for (const member of members) {
      if (member.userId === req.auth!.user.id) continue;
      await createNotification(member.userId, {
        type: 'group_invite',
        title: `Added to ${body.title}`,
        body: `${req.auth!.user.displayName} added you to a group.`,
        data: { conversationId: conversation.id },
      });
      emitToUser(member.userId, 'conversation:new', { conversationId: conversation.id });
    }

    res.status(201).json({ conversation: serializeConversation(conversation), members });
  }),
);

conversationRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const { conversation } = await requireMembership(id, req.auth!.user.id, { allowPending: true });
    res.json({
      conversation: serializeConversation(conversation),
      members: await listMembers(id),
      pinned: await listPinned(id, req.auth!.user.id),
    });
  }),
);

conversationRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().max(500).optional(),
        permissions: z
          .object({
            who_can_send: z.enum(['everyone', 'admins']).optional(),
            who_can_add: z.enum(['everyone', 'admins']).optional(),
            who_can_edit_info: z.enum(['everyone', 'admins']).optional(),
            who_can_invite: z.enum(['everyone', 'admins']).optional(),
          })
          .optional(),
      }),
      req.body,
    );

    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);
    if (conversation.type !== 'group') throw badRequest('Direct conversations have no group settings.');
    assertGroupCapability(membership, conversation, 'who_can_edit_info', 'Only admins can change group information.');

    if (body.permissions && membership.role === 'member') {
      throw forbidden('Only admins and the owner can change group permissions.');
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (body.title !== undefined) {
      params.push(body.title);
      sets.push(`title = $${params.length}`);
    }
    if (body.description !== undefined) {
      params.push(body.description);
      sets.push(`description = $${params.length}`);
    }
    if (body.permissions) {
      params.push(JSON.stringify({ ...conversation.permissions, ...body.permissions }));
      sets.push(`permissions = $${params.length}::jsonb`);
    }
    if (sets.length > 0) {
      await query(`UPDATE conversations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }

    if (body.title !== undefined && body.title !== conversation.title) {
      await postSystemMessage(id, {
        event: 'group_renamed',
        actorId: req.auth!.user.id,
        actorName: req.auth!.user.displayName,
        title: body.title,
      });
    }

    const updated = await one<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
    emitToConversation(id, 'conversation:updated', { conversationId: id });
    res.json({ conversation: serializeConversation(updated!) });
  }),
);

/** Per-member view state: mute, archive, pin, mark unread. Never affects anyone else. */
conversationRouter.patch(
  '/:id/state',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const body = parseBody(
      z.object({
        mutedUntil: z.string().datetime().nullable().optional(),
        archived: z.boolean().optional(),
        pinned: z.boolean().optional(),
        unread: z.boolean().optional(),
      }),
      req.body,
    );
    await requireMembership(id, req.auth!.user.id, { allowPending: true });
    await setConversationFlags(id, req.auth!.user.id, {
      muteUntil: body.mutedUntil,
      archived: body.archived,
      pinned: body.pinned,
      unread: body.unread,
    });
    res.json({ ok: true });
  }),
);

conversationRouter.get(
  '/:id/members',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    await requireMembership(id, req.auth!.user.id, { allowPending: true });
    res.json({ members: await listMembers(id) });
  }),
);

conversationRouter.post(
  '/:id/members',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const { memberIds } = parseBody(z.object({ memberIds: z.array(uuid).min(1).max(50) }), req.body);

    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);
    if (conversation.type !== 'group') throw badRequest('You cannot add people to a direct conversation.');
    assertGroupCapability(membership, conversation, 'who_can_add', 'Only admins can add people to this group.');

    for (const memberId of memberIds) {
      const blocks = await blockState(req.auth!.user.id, memberId);
      if (blocks.either) throw forbidden('One of the people you selected cannot be added.');
    }

    const added = await addMembers(id, req.auth!.user.id, memberIds);
    for (const memberId of added) {
      await createNotification(memberId, {
        type: 'group_invite',
        title: `Added to ${conversation.title ?? 'a group'}`,
        body: `${req.auth!.user.displayName} added you to a group.`,
        data: { conversationId: id },
      });
      emitToUser(memberId, 'conversation:new', { conversationId: id });
    }
    if (added.length > 0) {
      await postSystemMessage(id, {
        event: 'members_added',
        actorId: req.auth!.user.id,
        actorName: req.auth!.user.displayName,
        count: added.length,
      });
      emitToConversation(id, 'conversation:updated', { conversationId: id });
    }

    res.json({ added, members: await listMembers(id) });
  }),
);

conversationRouter.delete(
  '/:id/members/:userId',
  asyncRoute(async (req, res) => {
    const { id, userId } = parseQuery(z.object({ id: uuid, userId: uuid }), req.params);
    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);
    if (conversation.type !== 'group') throw badRequest('Direct conversations have no members to remove.');

    const isSelf = userId === req.auth!.user.id;
    if (!isSelf && membership.role === 'member') {
      throw forbidden('Only admins can remove people from this group.');
    }

    const target = await one<{ role: string }>(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
      [id, userId],
    );
    if (!target) throw notFound('That person is not in this group.');
    if (target.role === 'owner' && !isSelf) throw forbidden('The group owner cannot be removed.');
    if (target.role === 'owner' && isSelf) {
      throw conflict('Transfer ownership to someone else before leaving, or delete the group.');
    }
    if (target.role === 'admin' && membership.role === 'admin' && !isSelf) {
      throw forbidden('Admins cannot remove other admins.');
    }

    await removeMember(id, userId);
    await postSystemMessage(id, {
      event: isSelf ? 'member_left' : 'member_removed',
      actorId: req.auth!.user.id,
      actorName: req.auth!.user.displayName,
      targetId: userId,
    });
    emitToConversation(id, 'conversation:updated', { conversationId: id });
    emitToUser(userId, 'conversation:removed', { conversationId: id });
    res.json({ ok: true });
  }),
);

conversationRouter.patch(
  '/:id/members/:userId',
  asyncRoute(async (req, res) => {
    const { id, userId } = parseQuery(z.object({ id: uuid, userId: uuid }), req.params);
    const { role } = parseBody(z.object({ role: z.enum(['admin', 'member', 'owner']) }), req.body);
    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);

    if (conversation.type !== 'group') throw badRequest('Direct conversations have no roles.');
    if (membership.role !== 'owner') throw forbidden('Only the group owner can change roles.');
    if (userId === req.auth!.user.id) throw badRequest('You cannot change your own role.');

    if (role === 'owner') {
      // Ownership transfer: exactly one owner at any time.
      await query(
        `UPDATE conversation_members SET role = CASE WHEN user_id = $2 THEN 'owner'::member_role ELSE 'admin'::member_role END
          WHERE conversation_id = $1 AND user_id IN ($2, $3)`,
        [id, userId, req.auth!.user.id],
      );
    } else {
      await query(
        'UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
        [id, userId, role],
      );
    }

    emitToConversation(id, 'conversation:updated', { conversationId: id });
    res.json({ members: await listMembers(id) });
  }),
);

conversationRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);

    if (conversation.type === 'group') {
      if (membership.role !== 'owner') throw forbidden('Only the group owner can delete this group.');
      const memberIds = await listMemberIds(id);
      await query('UPDATE conversations SET deleted_at = now() WHERE id = $1', [id]);
      emitToUsers(memberIds, 'conversation:removed', { conversationId: id });
    } else {
      // Leaving a direct thread is per-person; the other side keeps their copy.
      await removeMember(id, req.auth!.user.id);
    }
    res.json({ ok: true });
  }),
);

conversationRouter.post(
  '/:id/invites',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const body = parseBody(
      z.object({
        expiresInHours: z.number().int().min(1).max(720).optional(),
        maxUses: z.number().int().min(1).max(1000).optional(),
      }),
      req.body,
    );

    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);
    if (conversation.type !== 'group') throw badRequest('Only groups can have invite links.');
    assertGroupCapability(membership, conversation, 'who_can_invite', 'Only admins can create invite links.');

    const code = generateToken(12);
    const expiresAt = body.expiresInHours ? new Date(Date.now() + body.expiresInHours * 3600_000) : null;
    const row = await one<{ id: string; code: string; expires_at: Date | null }>(
      `INSERT INTO invite_links (conversation_id, code, created_by, expires_at, max_uses)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, code, expires_at`,
      [id, code, req.auth!.user.id, expiresAt, body.maxUses ?? null],
    );

    res.status(201).json({
      invite: {
        id: row!.id,
        code: row!.code,
        url: `${env.APP_URL}/invite/${row!.code}`,
        expiresAt: row!.expires_at ? new Date(row!.expires_at).toISOString() : null,
        maxUses: body.maxUses ?? null,
      },
    });
  }),
);

conversationRouter.get(
  '/:id/invites',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);
    if (conversation.type !== 'group') throw badRequest('Only groups can have invite links.');
    assertGroupCapability(membership, conversation, 'who_can_invite', 'Only admins can see invite links.');

    const rows = await many<{
      id: string;
      code: string;
      expires_at: Date | null;
      max_uses: number | null;
      use_count: number;
      created_at: Date;
    }>(
      `SELECT id, code, expires_at, max_uses, use_count, created_at FROM invite_links
        WHERE conversation_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [id],
    );
    res.json({
      invites: rows.map((r) => ({
        id: r.id,
        code: r.code,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        maxUses: r.max_uses,
        useCount: r.use_count,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }),
);

conversationRouter.delete(
  '/:id/invites/:inviteId',
  asyncRoute(async (req, res) => {
    const { id, inviteId } = parseQuery(z.object({ id: uuid, inviteId: uuid }), req.params);
    const { conversation, membership } = await requireMembership(id, req.auth!.user.id);
    if (conversation.type !== 'group') throw badRequest('Only groups can have invite links.');
    assertGroupCapability(membership, conversation, 'who_can_invite', 'Only admins can revoke invite links.');
    await query('UPDATE invite_links SET revoked_at = now() WHERE id = $1 AND conversation_id = $2', [
      inviteId,
      id,
    ]);
    res.json({ ok: true });
  }),
);

/** Redeems an invite code. Group history stays sealed to keys the joiner never held. */
conversationRouter.post(
  '/invites/:code/join',
  asyncRoute(async (req, res) => {
    const { code } = parseQuery(z.object({ code: z.string().min(6).max(64) }), req.params);
    const invite = await one<{
      id: string;
      conversation_id: string;
      max_uses: number | null;
      use_count: number;
      expires_at: Date | null;
    }>(
      `SELECT id, conversation_id, max_uses, use_count, expires_at FROM invite_links
        WHERE code = $1 AND revoked_at IS NULL`,
      [code],
    );
    if (!invite) throw notFound('That invite link is not valid.');
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) throw badRequest('That invite link has expired.');
    if (invite.max_uses !== null && invite.use_count >= invite.max_uses) {
      throw badRequest('That invite link has been used the maximum number of times.');
    }

    const conversation = await one<ConversationRow>(
      'SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL',
      [invite.conversation_id],
    );
    if (!conversation) throw notFound('That group no longer exists.');

    const added = await addMembers(conversation.id, req.auth!.user.id, [req.auth!.user.id]);
    await query('UPDATE invite_links SET use_count = use_count + 1 WHERE id = $1', [invite.id]);

    if (added.length > 0) {
      await postSystemMessage(conversation.id, {
        event: 'member_joined',
        actorId: req.auth!.user.id,
        actorName: req.auth!.user.displayName,
      });
      emitToConversation(conversation.id, 'conversation:updated', { conversationId: conversation.id });
    }

    res.json({
      conversation: serializeConversation(conversation),
      members: await listMembers(conversation.id),
      // Sealed keys are per message; nothing sent before joining can be decrypted.
      historyVisible: false,
    });
  }),
);
