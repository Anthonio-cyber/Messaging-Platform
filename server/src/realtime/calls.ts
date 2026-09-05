import type { Server as SocketServer, Socket } from 'socket.io';
import { userRoom } from './emitter.js';
import { avatarUrl, findUserById } from '../services/user.service.js';
import {
  endCall,
  markAnswered,
  peerOf,
  requireParticipant,
  startCall,
  type CallKind,
} from '../services/call.service.js';

/**
 * WebRTC signalling.
 *
 * The server never sees audio or video. It authorises the pair, then relays session
 * descriptions and ICE candidates between two devices that negotiate a direct, DTLS-SRTP
 * encrypted path between themselves.
 *
 * Every relayed frame re-checks that the sender is actually a participant in the call it
 * names — otherwise anyone who guessed a call id could inject an SDP answer and hijack the
 * negotiation.
 */

type Ack = (response: unknown) => void;

const ok = (ack: Ack | undefined, payload: Record<string, unknown> = {}) =>
  ack?.({ ok: true, ...payload });

const fail = (ack: Ack | undefined, error: unknown) =>
  ack?.({
    ok: false,
    error: error instanceof Error ? error.message : 'Something went wrong with that call.',
  });

export function registerCallHandlers(
  io: SocketServer,
  socket: Socket,
  userId: string,
  displayName: string,
): void {
  const toPeer = (peerId: string, event: string, payload: unknown) => {
    io.to(userRoom(peerId)).emit(event, payload);
  };

  socket.on(
    'call:start',
    async (payload: { conversationId?: string; kind?: CallKind }, ack?: Ack) => {
      try {
        if (!payload?.conversationId) throw new Error('conversationId is required');
        const kind: CallKind = payload.kind === 'video' ? 'video' : 'audio';

        const { call, calleeId } = await startCall(userId, payload.conversationId, kind);
        const caller = await findUserById(userId);

        // Reaches every device the callee is signed in on; whichever answers first wins.
        toPeer(calleeId, 'call:incoming', {
          callId: call.id,
          conversationId: call.conversation_id,
          kind,
          from: {
            id: userId,
            displayName,
            customAddress: caller?.custom_address ?? null,
            avatarUrl: avatarUrl(caller?.avatar_key ?? null),
          },
        });

        ok(ack, { callId: call.id, calleeId });
      } catch (error) {
        fail(ack, error);
      }
    },
  );

  /** The callee's device acknowledging that it is alerting the user. */
  socket.on('call:ringing', async (payload: { callId?: string }, ack?: Ack) => {
    try {
      if (!payload?.callId) throw new Error('callId is required');
      const call = await requireParticipant(payload.callId, userId);
      const peer = peerOf(call, userId);
      if (peer) toPeer(peer, 'call:ringing', { callId: call.id });
      ok(ack);
    } catch (error) {
      fail(ack, error);
    }
  });

  socket.on('call:accept', async (payload: { callId?: string }, ack?: Ack) => {
    try {
      if (!payload?.callId) throw new Error('callId is required');
      const call = await requireParticipant(payload.callId, userId);
      if (call.callee_id !== userId) throw new Error('Only the person being called can accept.');

      await markAnswered(call.id);
      const peer = peerOf(call, userId);
      if (peer) toPeer(peer, 'call:accepted', { callId: call.id });

      // Other devices of the callee stop ringing.
      socket.to(userRoom(userId)).emit('call:handled', { callId: call.id });
      ok(ack);
    } catch (error) {
      fail(ack, error);
    }
  });

  // --- SDP and ICE relay -----------------------------------------------------
  // Opaque to the server: it forwards these verbatim without inspecting them.

  socket.on(
    'call:offer',
    async (payload: { callId?: string; sdp?: unknown }, ack?: Ack) => {
      try {
        if (!payload?.callId || !payload.sdp) throw new Error('callId and sdp are required');
        const call = await requireParticipant(payload.callId, userId);
        const peer = peerOf(call, userId);
        if (peer) toPeer(peer, 'call:offer', { callId: call.id, sdp: payload.sdp });
        ok(ack);
      } catch (error) {
        fail(ack, error);
      }
    },
  );

  socket.on(
    'call:answer',
    async (payload: { callId?: string; sdp?: unknown }, ack?: Ack) => {
      try {
        if (!payload?.callId || !payload.sdp) throw new Error('callId and sdp are required');
        const call = await requireParticipant(payload.callId, userId);
        const peer = peerOf(call, userId);
        if (peer) toPeer(peer, 'call:answer', { callId: call.id, sdp: payload.sdp });
        ok(ack);
      } catch (error) {
        fail(ack, error);
      }
    },
  );

  socket.on('call:ice', async (payload: { callId?: string; candidate?: unknown }) => {
    try {
      if (!payload?.callId || !payload.candidate) return;
      const call = await requireParticipant(payload.callId, userId);
      const peer = peerOf(call, userId);
      if (peer) toPeer(peer, 'call:ice', { callId: call.id, candidate: payload.candidate });
    } catch {
      // A candidate arriving after the call ended is normal; dropping it is correct.
    }
  });

  socket.on(
    'call:hangup',
    async (payload: { callId?: string; reason?: string }, ack?: Ack) => {
      try {
        if (!payload?.callId) throw new Error('callId is required');
        const call = await requireParticipant(payload.callId, userId);
        const reason = typeof payload.reason === 'string' ? payload.reason : 'hangup';

        const ended = await endCall(call.id, userId, reason);
        const peer = peerOf(call, userId);
        if (peer) {
          toPeer(peer, 'call:ended', { callId: call.id, reason, status: ended?.status ?? 'completed' });
        }
        // Stop any other device of this user that is still ringing.
        socket.to(userRoom(userId)).emit('call:handled', { callId: call.id });

        ok(ack, { status: ended?.status ?? 'completed' });
      } catch (error) {
        fail(ack, error);
      }
    },
  );
}
