import type { Request } from 'express';
import { many, one, query } from '../db/pool.js';
import { blindIndex } from '../lib/crypto.js';
import { clientIpHash, userAgent } from '../lib/http.js';
import { sendMail, templates } from '../lib/mailer.js';
import { decryptField } from '../lib/crypto.js';
import { createNotification } from './notification.service.js';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

export async function recordSecurityEvent(
  userId: string | null,
  eventType: string,
  req: Request | null,
  metadata: Record<string, unknown> = {},
  severity: SecuritySeverity = 'info',
): Promise<void> {
  await query(
    `INSERT INTO security_events (user_id, event_type, severity, ip_hash, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      eventType,
      severity,
      req ? clientIpHash(req) : null,
      req ? userAgent(req) : null,
      JSON.stringify(metadata),
    ],
  );
}

export async function recordLoginAttempt(
  identifier: string,
  userId: string | null,
  req: Request,
  successful: boolean,
): Promise<void> {
  await query(
    `INSERT INTO login_attempts (identifier_hash, user_id, ip_hash, user_agent, successful)
     VALUES ($1, $2, $3, $4, $5)`,
    [blindIndex(identifier), userId, clientIpHash(req), userAgent(req), successful],
  );
}

const MAX_FAILURES_PER_IDENTIFIER = 8;
const MAX_FAILURES_PER_IP = 25;
const WINDOW = "15 minutes";

/**
 * Durable brute-force check, shared across API instances because it reads the same table
 * every instance writes to. Complements the in-memory per-IP rate limiter.
 */
export async function isBruteForced(identifier: string, req: Request): Promise<boolean> {
  const row = await one<{ by_identifier: number; by_ip: number }>(
    `SELECT
       count(*) FILTER (WHERE identifier_hash = $1) AS by_identifier,
       count(*) FILTER (WHERE ip_hash = $2)         AS by_ip
     FROM login_attempts
     WHERE successful = FALSE AND created_at > now() - interval '${WINDOW}'`,
    [blindIndex(identifier), clientIpHash(req)],
  );
  if (!row) return false;
  return Number(row.by_identifier) >= MAX_FAILURES_PER_IDENTIFIER || Number(row.by_ip) >= MAX_FAILURES_PER_IP;
}

/**
 * A sign-in is "unfamiliar" when this account has never had a successful login from this
 * IP hash / user agent pair before. Not a fraud engine — a signal worth telling the user about.
 */
export async function isUnfamiliarLogin(userId: string, req: Request): Promise<boolean> {
  const row = await one(
    `SELECT 1 FROM sessions
      WHERE user_id = $1 AND ip_hash = $2 AND created_at < now()
      LIMIT 1`,
    [userId, clientIpHash(req)],
  );
  return row === null;
}

export async function notifyNewLogin(
  userId: string,
  deviceLabelText: string,
  recoveryEmailEnc: string | null,
  unfamiliar: boolean,
): Promise<void> {
  await createNotification(userId, {
    type: unfamiliar ? 'security_alert' : 'new_login',
    title: unfamiliar ? 'New sign-in from an unrecognised device' : 'New sign-in',
    body: `${deviceLabelText} signed in to your account.`,
    data: { device: deviceLabelText, unfamiliar },
  });

  if (!unfamiliar) return;
  const email = decryptField(recoveryEmailEnc);
  if (!email) return;

  const mail = templates.securityAlert(
    'New sign-in from an unrecognised device',
    `We saw a sign-in to your account from <strong>${deviceLabelText}</strong>. If that was you, no action is needed.`,
  );
  await sendMail({ ...mail, to: email });
}

export async function listSecurityEvents(userId: string, limit = 50) {
  return many(
    `SELECT id, event_type, severity, user_agent, metadata, created_at
       FROM security_events WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}
