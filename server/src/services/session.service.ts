import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { many, one, query } from '../db/pool.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { clientIpHash, deviceLabel, userAgent } from '../lib/http.js';
import type { AuthContext, SessionRow, UserRow } from '../types.js';

export const SESSION_COOKIE = 'veylo_session';

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(userId: string, req: Request): Promise<IssuedSession> {
  const token = generateToken(32);
  const ua = userAgent(req);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);

  const row = await one<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, device_label, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [userId, hashToken(token), deviceLabel(ua), ua, clientIpHash(req), expiresAt],
  );

  return { token, sessionId: row!.id, expiresAt };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  });
}

type SessionWithUser = SessionRow & {
  u_id: string;
  username: string;
  custom_address: string;
  display_name: string;
  role: UserRow['role'];
  status: UserRow['status'];
  avatar_key: string | null;
};

/**
 * Resolves a bearer/cookie token to a live session. Expired, revoked, idle-timed-out and
 * banned principals all resolve to null so callers never need to re-check those.
 */
export async function resolveSession(token: string): Promise<AuthContext | null> {
  const row = await one<SessionWithUser>(
    `SELECT s.*, u.id AS u_id, u.username, u.custom_address, u.display_name,
            u.role, u.status, u.avatar_key
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.deleted_at IS NULL`,
    [hashToken(token)],
  );
  if (!row) return null;

  const idleLimitMs = env.SESSION_IDLE_TIMEOUT_HOURS * 3600 * 1000;
  if (Date.now() - new Date(row.last_active_at).getTime() > idleLimitMs) {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [row.id]);
    return null;
  }

  if (row.status === 'banned' || row.status === 'deleted') return null;

  return {
    sessionId: row.id,
    user: {
      id: row.u_id,
      username: row.username,
      customAddress: row.custom_address,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      avatarKey: row.avatar_key,
    },
  };
}

/** Throttled write so every request does not touch the sessions table. */
const lastTouched = new Map<string, number>();
export async function touchSession(sessionId: string): Promise<void> {
  const now = Date.now();
  const previous = lastTouched.get(sessionId) ?? 0;
  if (now - previous < 60_000) return;
  lastTouched.set(sessionId, now);
  await query('UPDATE sessions SET last_active_at = now() WHERE id = $1', [sessionId]);
}

export async function revokeSession(sessionId: string, userId: string): Promise<boolean> {
  const result = await query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [sessionId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const result = await query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
  return result.rowCount ?? 0;
}

export async function listSessions(userId: string): Promise<SessionRow[]> {
  return many<SessionRow>(
    `SELECT * FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_active_at DESC`,
    [userId],
  );
}

export async function purgeExpiredSessions(): Promise<number> {
  const result = await query(
    `DELETE FROM sessions WHERE expires_at < now() - interval '30 days'
        OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`,
  );
  return result.rowCount ?? 0;
}
