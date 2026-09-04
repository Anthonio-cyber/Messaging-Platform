import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import cookie from 'cookie';
import { env } from '../config/env.js';
import { many } from '../db/pool.js';
import { SESSION_COOKIE, resolveSession, touchSession } from '../services/session.service.js';
import { requireMembership } from '../services/conversation.service.js';
import { markDelivered, markRead } from '../services/message.service.js';
import { getPrivacy, setPresence } from '../services/user.service.js';
import { attachRealtime, conversationRoom, emitToUser, userRoom } from './emitter.js';
import type { AuthContext } from '../types.js';

interface SocketData {
  auth: AuthContext;
}

/** Typing state is ephemeral: held in memory, expired on a timer, never written to the DB. */
const typingTimers = new Map<string, NodeJS.Timeout>();
const TYPING_TTL_MS = 6000;

export function createRealtimeServer(httpServer: HttpServer): SocketServer {
  const io = new SocketServer(httpServer, {
    path: '/realtime',
    cors: { origin: env.corsOrigins, credentials: true },
    serveClient: false,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6,
  });

  // Authenticate before the connection is established. An unauthenticated socket never joins.
  io.use(async (socket, next) => {
    try {
      const header = socket.handshake.headers.cookie;
      const cookies = header ? cookie.parse(header) : {};
      const token =
        cookies[SESSION_COOKIE] ??
        (typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined);

      if (!token) return next(new Error('unauthorized'));

      const auth = await resolveSession(token);
      if (!auth) return next(new Error('unauthorized'));
      if (auth.user.status === 'banned' || auth.user.status === 'suspended') {
        return next(new Error('account_unavailable'));
      }

      (socket.data as SocketData).auth = auth;
      next();
    } catch (error) {
      next(error as Error);
    }
  });

  io.on('connection', (socket) => {
    void onConnection(io, socket);
  });

  attachRealtime(io);
  return io;
}

async function onConnection(io: SocketServer, socket: Socket): Promise<void> {
  const { auth } = socket.data as SocketData;
  const userId = auth.user.id;

  await socket.join(userRoom(userId));

  // Join every live conversation so broadcasts reach this device.
  const conversationIds = await many<{ conversation_id: string }>(
    `SELECT conversation_id FROM conversation_members
      WHERE user_id = $1 AND left_at IS NULL AND is_active = TRUE`,
    [userId],
  );
  for (const row of conversationIds) await socket.join(conversationRoom(row.conversation_id));

  await setPresence(userId, 'online');
  await broadcastPresence(userId, 'online');
  void touchSession(auth.sessionId);

  // Anything that arrived while this user was away is now delivered.
  const pending = await many<{ message_id: string }>(
    `SELECT ms.message_id FROM message_status ms
       JOIN messages m ON m.id = ms.message_id
      WHERE ms.user_id = $1 AND ms.delivered_at IS NULL
      ORDER BY m.created_at DESC LIMIT 500`,
    [userId],
  );
  if (pending.length > 0) {
    const ids = pending.map((p) => p.message_id);
    await markDelivered(userId, ids);
    const senders = await many<{ conversation_id: string; sender_id: string }>(
      `SELECT DISTINCT conversation_id, sender_id FROM messages WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const s of senders) {
      if (s.sender_id) {
        io.to(userRoom(s.sender_id)).emit('message:delivered', {
          conversationId: s.conversation_id,
          recipientId: userId,
          messageIds: ids,
        });
      }
    }
  }

  socket.emit('ready', { userId, conversations: conversationIds.map((c) => c.conversation_id) });

  socket.on('conversation:join', async (payload: { conversationId?: string }, ack?: (r: unknown) => void) => {
    try {
      if (!payload?.conversationId) throw new Error('conversationId required');
      // Re-checks membership: a socket cannot subscribe to a room it has no access to.
      await requireMembership(payload.conversationId, userId, { allowPending: true });
      await socket.join(conversationRoom(payload.conversationId));
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false, error: 'not_authorized' });
    }
  });

  socket.on('conversation:leave', async (payload: { conversationId?: string }) => {
    if (payload?.conversationId) await socket.leave(conversationRoom(payload.conversationId));
  });

  socket.on('typing:start', async (payload: { conversationId?: string }) => {
    if (!payload?.conversationId) return;
    try {
      await requireMembership(payload.conversationId, userId);
      const privacy = await getPrivacy(userId);
      // Someone who hides their typing indicator never emits one.
      if (!privacy.typing_indicators) return;

      socket.to(conversationRoom(payload.conversationId)).emit('typing:update', {
        conversationId: payload.conversationId,
        userId,
        displayName: auth.user.displayName,
        typing: true,
      });

      const key = `${payload.conversationId}:${userId}`;
      clearTimeout(typingTimers.get(key));
      typingTimers.set(
        key,
        setTimeout(() => {
          typingTimers.delete(key);
          io.to(conversationRoom(payload.conversationId!)).emit('typing:update', {
            conversationId: payload.conversationId,
            userId,
            typing: false,
          });
        }, TYPING_TTL_MS),
      );
    } catch {
      /* not a member — stay silent */
    }
  });

  socket.on('typing:stop', (payload: { conversationId?: string }) => {
    if (!payload?.conversationId) return;
    const key = `${payload.conversationId}:${userId}`;
    clearTimeout(typingTimers.get(key));
    typingTimers.delete(key);
    socket.to(conversationRoom(payload.conversationId)).emit('typing:update', {
      conversationId: payload.conversationId,
      userId,
      typing: false,
    });
  });

  socket.on(
    'message:read',
    async (payload: { conversationId?: string; messageId?: string }, ack?: (r: unknown) => void) => {
      try {
        if (!payload?.conversationId || !payload?.messageId) throw new Error('invalid');
        await requireMembership(payload.conversationId, userId);
        const privacy = await getPrivacy(userId);
        const result = await markRead(payload.conversationId, userId, payload.messageId, privacy.read_receipts);

        if (privacy.read_receipts && result.messageIds.length > 0) {
          socket.to(conversationRoom(payload.conversationId)).emit('message:read', {
            conversationId: payload.conversationId,
            readerId: userId,
            messageIds: result.messageIds,
          });
        }
        ack?.({ ok: true, read: result.messageIds.length });
      } catch {
        ack?.({ ok: false });
      }
    },
  );

  socket.on('presence:set', async (payload: { presence?: 'online' | 'away' | 'offline' }) => {
    const presence = payload?.presence;
    if (presence !== 'online' && presence !== 'away' && presence !== 'offline') return;
    await setPresence(userId, presence);
    await broadcastPresence(userId, presence);
  });

  socket.on('disconnect', async () => {
    // Presence flips only when the user's last device disconnects.
    const remaining = await io.in(userRoom(userId)).fetchSockets();
    if (remaining.length === 0) {
      await setPresence(userId, 'offline');
      await broadcastPresence(userId, 'offline');
    }
  });
}

/**
 * Presence goes to contacts and to people the user shares a conversation with, and only when
 * their own visibility setting permits it.
 */
async function broadcastPresence(userId: string, presence: string): Promise<void> {
  const privacy = await getPrivacy(userId);
  if (privacy.online_status_visible === 'nobody') return;

  const audience = await many<{ user_id: string }>(
    `SELECT DISTINCT cm2.user_id
       FROM conversation_members cm1
       JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
      WHERE cm1.user_id = $1 AND cm1.left_at IS NULL AND cm2.left_at IS NULL AND cm2.user_id <> $1
      UNION
     SELECT contact_id AS user_id FROM contacts WHERE user_id = $1`,
    [userId],
  );

  const contactsOnly = privacy.online_status_visible === 'contacts';
  const contactIds = contactsOnly
    ? new Set(
        (await many<{ contact_id: string }>('SELECT contact_id FROM contacts WHERE user_id = $1', [userId])).map(
          (r) => r.contact_id,
        ),
      )
    : null;

  for (const row of audience) {
    if (contactIds && !contactIds.has(row.user_id)) continue;
    emitToUser(row.user_id, 'presence:update', { userId, presence });
  }
}

export async function shutdownRealtime(io: SocketServer): Promise<void> {
  for (const timer of typingTimers.values()) clearTimeout(timer);
  typingTimers.clear();
  await new Promise<void>((resolve) => io.close(() => resolve()));
}
