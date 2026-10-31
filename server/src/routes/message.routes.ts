import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { one } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/rateLimit.js';
import {
  assertGroupCapability,
  listMemberIds,
  requireMembership,
} from '../services/conversation.service.js';
import {
  deleteMessage,
  editMessage,
  getMessageForViewer,
  listMessages,
  listPinned,
  markDelivered,
  markRead,
  pinMessage,
  sendMessage,
  toggleReaction,
} from '../services/message.service.js';
import { MAX_PENDING_MESSAGES, countPendingMessages } from '../services/request.service.js';
import { blockState, getPrivacy } from '../services/user.service.js';
import { createNotification } from '../services/notification.service.js';
import { emitToConversation, emitToUser, emitToUsers } from '../realtime/emitter.js';

export const messageRouter: Router = Router();
messageRouter.use(requireAuth());

const uuid = z.string().uuid();
const wrappedKeys = z
  .array(z.object({ userId: uuid, wrappedKey: z.string().min(8).max(2048) }))
  .min(1)
  .max(256);

messageRouter.get(
  '/:conversationId/messages',
  asyncRoute(async (req, res) => {
    const { conversationId } = parseQuery(z.object({ conversationId: uuid }), req.params);
    const { limit, before, after } = parseQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(40),
        before: uuid.optional(),
        after: uuid.optional(),
      }),
      req.query,
    );

    await requireMembership(conversationId, req.auth!.user.id, { allowPending: true });
    const page = await listMessages(conversationId, req.auth!.user.id, { limit, before, after });

    // Anything the reader just received counts as delivered.
    const inbound = page.messages.filter((m) => m.senderId !== req.auth!.user.id).map((m) => m.id);
    if (inbound.length > 0) void markDelivered(req.auth!.user.id, inbound);

    res.json(page);
  }),
);

/**
 * Sends a message. The body is already ciphertext; `keys` carries one copy of the message key
 * sealed to each member's public key. The server verifies the key set covers exactly the
 * conversation's members and never sees the plaintext.
 */
messageRouter.post(
  '/:conversationId/messages',
  limiters.sendMessage,
  asyncRoute(async (req, res) => {
    const { conversationId } = parseQuery(z.object({ conversationId: uuid }), req.params);
    const body = parseBody(
      z.object({
        ciphertext: z.string().min(1).max(90_000),
        nonce: z.string().min(8).max(128),
        keys: wrappedKeys,
        kind: z.enum(['text', 'attachment']).default('text'),
        replyToId: uuid.nullish(),
        forwardedFrom: uuid.nullish(),
        attachmentIds: z.array(uuid).max(10).optional(),
        mentions: z.array(uuid).max(50).optional(),
      }),
      req.body,
    );

    const senderId = req.auth!.user.id;
    const { conversation, membership } = await requireMembership(conversationId, senderId, {
      allowPending: true,
    });

    if (conversation.type === 'group') {
      if (!membership.is_active) throw forbidden('You are not an active member of this group.');
      assertGroupCapability(membership, conversation, 'who_can_send', 'Only admins can post in this group.');
    } else {
      const otherId = (await listMemberIds(conversationId)).find((id) => id !== senderId);
      if (otherId) {
        const blocks = await blockState(senderId, otherId);
        if (blocks.viewerBlockedTarget) throw forbidden('Unblock this person before messaging them.');
        // A blocked sender is stopped here; the message is never stored or delivered.
        if (blocks.targetBlockedViewer) throw forbidden('This person is not accepting messages.');

        const otherMembership = await one<{ is_active: boolean }>(
          'SELECT is_active FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, otherId],
        );
        if (otherMembership && !otherMembership.is_active) {
          // The request has not been accepted yet: the requester gets a small allowance.
          const sent = await countPendingMessages(conversationId, senderId);
          if (sent >= MAX_PENDING_MESSAGES) {
            throw forbidden(
              `You can send up to ${MAX_PENDING_MESSAGES} messages until this person accepts your request.`,
            );
          }
        }
      }
    }

    const message = await sendMessage({
      conversationId,
      senderId,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      kind: body.kind,
      keys: body.keys,
      replyToId: body.replyToId ?? null,
      forwardedFrom: body.forwardedFrom ?? null,
      attachmentIds: body.attachmentIds,
    });

    const memberIds = await listMemberIds(conversationId);
    const recipients = memberIds.filter((id) => id !== senderId);

    // Each recipient needs their own sealed key, so the payload is personalised per socket room.
    for (const recipientId of recipients) {
      const personal = await getMessageForViewer(message.id, recipientId);
      if (personal) emitToUser(recipientId, 'message:new', { conversationId, message: personal });
    }
    emitToUser(senderId, 'message:new', { conversationId, message });

    const title =
      conversation.type === 'group'
        ? `${req.auth!.user.displayName} in ${conversation.title ?? 'a group'}`
        : req.auth!.user.displayName;

    for (const recipientId of recipients) {
      const muted = await one<{ muted: boolean }>(
        `SELECT (muted_until IS NOT NULL AND muted_until > now()) AS muted
           FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, recipientId],
      );
      if (muted?.muted) continue;

      const mentioned = body.mentions?.includes(recipientId) ?? false;
      const isReply = Boolean(body.replyToId);
      await createNotification(recipientId, {
        type: mentioned ? 'mention' : isReply ? 'reply' : 'new_message',
        title,
        // Notification bodies stay generic: the server cannot read the message.
        body: mentioned ? 'Mentioned you in a message.' : isReply ? 'Replied to your message.' : 'Sent you a message.',
        data: { conversationId, messageId: message.id },
      });
    }

    res.status(201).json({ message });
  }),
);

messageRouter.patch(
  '/messages/:messageId',
  asyncRoute(async (req, res) => {
    const { messageId } = parseQuery(z.object({ messageId: uuid }), req.params);
    const body = parseBody(
      z.object({
        ciphertext: z.string().min(1).max(90_000),
        nonce: z.string().min(8).max(128),
        keys: wrappedKeys,
      }),
      req.body,
    );

    const message = await editMessage(messageId, req.auth!.user.id, body.ciphertext, body.nonce, body.keys);
    const memberIds = await listMemberIds(message.conversationId);
    for (const memberId of memberIds) {
      const personal = await getMessageForViewer(messageId, memberId);
      if (personal) emitToUser(memberId, 'message:updated', { conversationId: message.conversationId, message: personal });
    }
    res.json({ message });
  }),
);

messageRouter.delete(
  '/messages/:messageId',
  asyncRoute(async (req, res) => {
    const { messageId } = parseQuery(z.object({ messageId: uuid }), req.params);
    const { scope } = parseQuery(
      z.object({ scope: z.enum(['me', 'everyone']).default('everyone') }),
      req.query,
    );

    const { conversationId } = await deleteMessage(messageId, req.auth!.user.id, scope === 'everyone');
    if (scope === 'everyone') {
      emitToConversation(conversationId, 'message:deleted', { conversationId, messageId });
    } else {
      emitToUser(req.auth!.user.id, 'message:deleted', { conversationId, messageId });
    }
    res.json({ ok: true });
  }),
);

messageRouter.post(
  '/messages/:messageId/reactions',
  asyncRoute(async (req, res) => {
    const { messageId } = parseQuery(z.object({ messageId: uuid }), req.params);
    const { emoji } = parseBody(
      // Cap length so the column cannot be used as free-form storage.
      z.object({ emoji: z.string().min(1).max(16) }),
      req.body,
    );
    const result = await toggleReaction(messageId, req.auth!.user.id, emoji);
    const memberIds = await listMemberIds(result.conversationId);
    for (const memberId of memberIds) {
      const personal = await getMessageForViewer(messageId, memberId);
      if (personal) {
        emitToUser(memberId, 'message:updated', { conversationId: result.conversationId, message: personal });
      }
    }
    res.json({ added: result.added });
  }),
);

messageRouter.post(
  '/:conversationId/read',
  asyncRoute(async (req, res) => {
    const { conversationId } = parseQuery(z.object({ conversationId: uuid }), req.params);
    const { messageId } = parseBody(z.object({ messageId: uuid }), req.body);

    await requireMembership(conversationId, req.auth!.user.id);
    const privacy = await getPrivacy(req.auth!.user.id);
    const result = await markRead(conversationId, req.auth!.user.id, messageId, privacy.read_receipts);

    // With read receipts off, the reader's own badge clears but nobody else is told.
    if (privacy.read_receipts && result.messageIds.length > 0) {
      emitToConversation(conversationId, 'message:read', {
        conversationId,
        readerId: req.auth!.user.id,
        messageIds: result.messageIds,
      });
    }
    res.json({ read: result.messageIds.length });
  }),
);

messageRouter.post(
  '/messages/delivered',
  asyncRoute(async (req, res) => {
    const { messageIds } = parseBody(z.object({ messageIds: z.array(uuid).min(1).max(200) }), req.body);
    await markDelivered(req.auth!.user.id, messageIds);
    res.json({ ok: true });
  }),
);

messageRouter.post(
  '/:conversationId/pins/:messageId',
  asyncRoute(async (req, res) => {
    const { conversationId, messageId } = parseQuery(
      z.object({ conversationId: uuid, messageId: uuid }),
      req.params,
    );
    const { conversation, membership } = await requireMembership(conversationId, req.auth!.user.id);
    if (conversation.type === 'group') {
      assertGroupCapability(membership, conversation, 'who_can_edit_info', 'Only admins can pin messages here.');
    }
    const result = await pinMessage(conversationId, messageId, req.auth!.user.id);
    emitToConversation(conversationId, 'conversation:updated', { conversationId });
    res.json(result);
  }),
);

messageRouter.get(
  '/:conversationId/pins',
  asyncRoute(async (req, res) => {
    const { conversationId } = parseQuery(z.object({ conversationId: uuid }), req.params);
    await requireMembership(conversationId, req.auth!.user.id, { allowPending: true });
    res.json({ pinned: await listPinned(conversationId, req.auth!.user.id) });
  }),
);

/**
 * Forwards a message into another conversation. The client re-encrypts the plaintext for the
 * destination's members, so this is a normal send that remembers where it came from.
 */
messageRouter.post(
  '/messages/:messageId/forward',
  limiters.sendMessage,
  asyncRoute(async (req, res) => {
    const { messageId } = parseQuery(z.object({ messageId: uuid }), req.params);
    const body = parseBody(
      z.object({
        conversationId: uuid,
        ciphertext: z.string().min(1).max(90_000),
        nonce: z.string().min(8).max(128),
        keys: wrappedKeys,
      }),
      req.body,
    );

    const source = await getMessageForViewer(messageId, req.auth!.user.id);
    if (!source || !source.wrappedKey) throw notFound('That message is not available to forward.');
    await requireMembership(source.conversationId, req.auth!.user.id);

    const { conversation, membership } = await requireMembership(body.conversationId, req.auth!.user.id);
    if (conversation.type === 'group') {
      assertGroupCapability(membership, conversation, 'who_can_send', 'Only admins can post in this group.');
    }

    const message = await sendMessage({
      conversationId: body.conversationId,
      senderId: req.auth!.user.id,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      keys: body.keys,
      forwardedFrom: messageId,
    });

    const memberIds = await listMemberIds(body.conversationId);
    for (const memberId of memberIds) {
      const personal = await getMessageForViewer(message.id, memberId);
      if (personal) {
        emitToUser(memberId, 'message:new', { conversationId: body.conversationId, message: personal });
      }
    }
    res.status(201).json({ message });
  }),
);

/**
 * Loads a window of messages around a target message so the client can jump to a search hit.
 * Message search itself runs on the client: the server holds only ciphertext.
 */
messageRouter.get(
  '/:conversationId/context/:messageId',
  asyncRoute(async (req, res) => {
    const { conversationId, messageId } = parseQuery(
      z.object({ conversationId: uuid, messageId: uuid }),
      req.params,
    );
    await requireMembership(conversationId, req.auth!.user.id);

    const target = await one<{ id: string }>(
      'SELECT id FROM messages WHERE id = $1 AND conversation_id = $2',
      [messageId, conversationId],
    );
    if (!target) throw notFound('That message is not in this conversation.');

    const before = await listMessages(conversationId, req.auth!.user.id, { limit: 20, before: messageId });
    const after = await listMessages(conversationId, req.auth!.user.id, { limit: 20, after: messageId });
    const focus = await getMessageForViewer(messageId, req.auth!.user.id);
    if (!focus) throw badRequest('You do not hold a key for that message.');

    res.json({ messages: [...before.messages, focus, ...after.messages], focusId: messageId });
  }),
);

export { emitToUsers };
