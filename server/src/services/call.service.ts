import { many, one, query } from '../db/pool.js';
import { env } from '../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { avatarUrl, blockState } from './user.service.js';
import { listMemberIds, requireMembership } from './conversation.service.js';

/**
 * Call signalling and history.
 *
 * The server is only a matchmaker: it authorises the pair, records that a call happened, and
 * relays SDP and ICE between the two devices. Audio and video go peer-to-peer over WebRTC,
 * encrypted with DTLS-SRTP; no media reaches this process.
 */

export type CallKind = 'audio' | 'video';
export type CallStatus =
  | 'ringing'
  | 'active'
  | 'completed'
  | 'missed'
  | 'declined'
  | 'cancelled'
  | 'failed';

export interface CallRow {
  id: string;
  conversation_id: string;
  caller_id: string | null;
  callee_id: string | null;
  kind: CallKind;
  status: CallStatus;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
}

/** How long an unanswered call rings before it is recorded as missed. */
export const RING_TIMEOUT_MS = 45_000;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * The ICE servers a browser needs to negotiate a path. Handed out per request rather than
 * baked into the bundle, so TURN credentials can be rotated without a redeploy.
 */
export function iceServers(): { iceServers: IceServer[]; hasRelay: boolean } {
  const servers: IceServer[] = [];
  if (env.stunUrls.length > 0) servers.push({ urls: env.stunUrls });

  const hasRelay = env.turnUrls.length > 0 && Boolean(env.TURN_USERNAME && env.TURN_CREDENTIAL);
  if (hasRelay) {
    servers.push({
      urls: env.turnUrls,
      username: env.TURN_USERNAME!,
      credential: env.TURN_CREDENTIAL!,
    });
  }
  return { iceServers: servers, hasRelay };
}

export interface StartCallResult {
  call: CallRow;
  calleeId: string;
}

/**
 * Authorises and records a new call. A caller must share a live direct conversation with the
 * callee, neither may have blocked the other, and neither may already be on a call.
 */
export async function startCall(
  callerId: string,
  conversationId: string,
  kind: CallKind,
): Promise<StartCallResult> {
  if (!env.CALLS_ENABLED) throw forbidden('Calling is turned off on this deployment.');

  const { conversation } = await requireMembership(conversationId, callerId);
  if (conversation.type !== 'direct') {
    // Group calls need a media server to mix or forward streams; peer-to-peer does not scale
    // past two participants. Refusing plainly beats a call that half works.
    throw badRequest('Group calls are not supported yet. You can call people one to one.');
  }

  const calleeId = (await listMemberIds(conversationId)).find((id) => id !== callerId);
  if (!calleeId) throw notFound('There is nobody to call in this conversation.');

  const blocks = await blockState(callerId, calleeId);
  if (blocks.viewerBlockedTarget) throw forbidden('Unblock this person before calling them.');
  if (blocks.targetBlockedViewer) throw forbidden('This person is not accepting calls.');

  const busy = await one<{ id: string }>(
    `SELECT id FROM calls
      WHERE status IN ('ringing', 'active')
        AND (caller_id IN ($1, $2) OR callee_id IN ($1, $2))
      LIMIT 1`,
    [callerId, calleeId],
  );
  if (busy) throw conflict('One of you is already on a call.');

  const created = await one<CallRow>(
    `INSERT INTO calls (conversation_id, caller_id, callee_id, kind)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [conversationId, callerId, calleeId, kind],
  );
  return { call: created!, calleeId };
}

export async function getCall(callId: string): Promise<CallRow | null> {
  return one<CallRow>('SELECT * FROM calls WHERE id = $1', [callId]);
}

/** Both directions of the relay check this: a stranger must not be able to inject SDP. */
export async function requireParticipant(callId: string, userId: string): Promise<CallRow> {
  const call = await getCall(callId);
  if (!call) throw notFound('That call no longer exists.');
  if (call.caller_id !== userId && call.callee_id !== userId) {
    throw forbidden('You are not part of this call.');
  }
  return call;
}

export function peerOf(call: CallRow, userId: string): string | null {
  if (call.caller_id === userId) return call.callee_id;
  if (call.callee_id === userId) return call.caller_id;
  return null;
}

export async function markAnswered(callId: string): Promise<void> {
  await query(
    `UPDATE calls SET status = 'active', answered_at = now()
      WHERE id = $1 AND status = 'ringing'`,
    [callId],
  );
}

/**
 * Closes a call out. The recorded status distinguishes the cases a call log needs to show
 * differently: answered and hung up, never answered, refused, or cancelled by the caller.
 */
export async function endCall(
  callId: string,
  endedBy: string,
  reason: string,
): Promise<CallRow | null> {
  const call = await getCall(callId);
  if (!call || call.ended_at) return call;

  let status: CallStatus;
  if (call.status === 'active') {
    status = 'completed';
  } else if (reason === 'declined') {
    status = 'declined';
  } else if (reason === 'failed') {
    status = 'failed';
  } else if (endedBy === call.caller_id) {
    status = 'cancelled';
  } else {
    status = 'missed';
  }

  return one<CallRow>(
    `UPDATE calls SET status = $2, ended_at = now(), end_reason = $3
      WHERE id = $1 RETURNING *`,
    [callId, status, reason.slice(0, 120)],
  );
}

/** Sweeps calls that rang out because a device went away without hanging up. */
export async function expireStaleCalls(): Promise<number> {
  const result = await query(
    `UPDATE calls SET status = 'missed', ended_at = now(), end_reason = 'timeout'
      WHERE status = 'ringing' AND started_at < now() - interval '2 minutes'`,
  );
  return result.rowCount ?? 0;
}

export interface CallHistoryEntry {
  id: string;
  conversationId: string;
  kind: CallKind;
  status: CallStatus;
  direction: 'incoming' | 'outgoing';
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  counterpart: {
    id: string | null;
    displayName: string;
    customAddress: string | null;
    avatarUrl: string | null;
  };
}

export async function listCallHistory(userId: string, limit = 50): Promise<CallHistoryEntry[]> {
  const rows = await many<{
    id: string;
    conversation_id: string;
    kind: CallKind;
    status: CallStatus;
    caller_id: string | null;
    started_at: Date;
    answered_at: Date | null;
    ended_at: Date | null;
    other_id: string | null;
    other_name: string | null;
    other_address: string | null;
    other_avatar: string | null;
  }>(
    `SELECT c.id, c.conversation_id, c.kind, c.status, c.caller_id,
            c.started_at, c.answered_at, c.ended_at,
            u.id AS other_id, u.display_name AS other_name,
            u.custom_address AS other_address, u.avatar_key AS other_avatar
       FROM calls c
       LEFT JOIN users u
         ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
      WHERE c.caller_id = $1 OR c.callee_id = $1
      ORDER BY c.started_at DESC
      LIMIT $2`,
    [userId, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.kind,
    status: r.status,
    direction: r.caller_id === userId ? 'outgoing' : 'incoming',
    startedAt: new Date(r.started_at).toISOString(),
    answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : null,
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    durationSeconds:
      r.answered_at && r.ended_at
        ? Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.answered_at).getTime()) / 1000))
        : null,
    counterpart: {
      id: r.other_id,
      displayName: r.other_name ?? 'Deleted account',
      customAddress: r.other_address,
      avatarUrl: avatarUrl(r.other_avatar),
    },
  }));
}
