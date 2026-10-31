import webpush from 'web-push';
import { many, query } from '../db/pool.js';
import { env } from '../config/env.js';

/**
 * Web Push: notifications that arrive when Veylo is not open.
 *
 * This is the one place where something about a conversation leaves this system and travels
 * through infrastructure Veylo does not control, so it is worth being precise about what does
 * and does not go.
 *
 * The payload is encrypted to the subscribing browser's own key pair (RFC 8291) before it
 * leaves here, so Mozilla, Google or Apple relay bytes they cannot read. What they can see is
 * unavoidable and real: that a particular endpoint received a push, how large it was, and when.
 * Over time that is a usable picture of when someone is being contacted, though not by whom and
 * not about what.
 *
 * What Veylo puts inside the payload is therefore the minimum that makes the notification worth
 * showing: who it is from and which conversation to open. Never message content — this server
 * holds only ciphertext and could not include it if it wanted to. The body text a recipient
 * sees for a message is produced on their own device after decryption; the push only wakes it.
 */

let configured = false;

/**
 * web-push refuses to send without VAPID details, and they are optional config, so this is
 * resolved lazily rather than at import time — a deployment with no push keys must still boot.
 */
function ensureConfigured(): boolean {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    configured = true;
  }
  return true;
}

export function pushEnabled(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

export async function saveSubscription(userId: string, input: PushSubscriptionInput): Promise<void> {
  // The endpoint is unique across accounts on purpose. One browser, one subscription: if
  // somebody signs out and another person signs in, the row moves rather than multiplying, so
  // the first account stops being notified on a device it no longer owns.
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           failure_count = 0`,
    [userId, input.endpoint, input.p256dh, input.auth, (input.userAgent ?? '').slice(0, 300)],
  );
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

export async function countSubscriptions(userId: string): Promise<number> {
  const rows = await many<{ count: string }>(
    'SELECT count(*)::text AS count FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

/** How many consecutive soft failures before an endpoint is assumed dead and dropped. */
const MAX_FAILURES = 5;

export interface PushMessage {
  /** Short, and never message content — see the note at the top of this file. */
  title: string;
  body?: string;
  /** Where clicking should land, as an in-app path. */
  path?: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag?: string;
  /** Incoming calls want to cut through a quiet device; messages do not. */
  urgent?: boolean;
}

/**
 * Sends to every browser this account has registered.
 *
 * Failures are expected in normal operation — people close browsers, clear site data, and
 * revoke permission without telling anyone — so a dead endpoint is pruned rather than retried
 * forever. 404 and 410 from a push service mean the subscription is gone for good; anything
 * else might be transient, so it counts against a budget instead.
 *
 * Never throws. A notification that cannot be delivered must not take down the message that
 * triggered it.
 */
export async function sendPush(userId: string, message: PushMessage): Promise<number> {
  if (!ensureConfigured()) return 0;

  const subscriptions = await many<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  if (subscriptions.length === 0) return 0;

  const payload = JSON.stringify({
    title: message.title,
    body: message.body ?? '',
    path: message.path ?? '/app',
    tag: message.tag,
  });

  let delivered = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
          {
            // A ringing call is worthless a minute late; a message is still worth showing.
            TTL: message.urgent ? 30 : 600,
            urgency: message.urgent ? 'high' : 'normal',
          },
        );
        delivered += 1;
        await query('UPDATE push_subscriptions SET last_used_at = now(), failure_count = 0 WHERE id = $1', [
          subscription.id,
        ]);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // The push service is telling us this subscription no longer exists. Believe it.
          await query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
          return;
        }
        const updated = await query<{ failure_count: number }>(
          'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1 RETURNING failure_count',
          [subscription.id],
        );
        if ((updated.rows[0]?.failure_count ?? 0) >= MAX_FAILURES) {
          await query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
        }
      }
    }),
  );

  return delivered;
}
