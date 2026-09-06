import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import { decryptField } from '../lib/crypto.js';
import { one, query } from '../db/pool.js';
import { limiters } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import {
  findUserById,
  findUserByIdentifier,
  getPrivacy,
  searchDirectory,
  toPublicProfile,
  toSelfProfile,
} from '../services/user.service.js';
import { listSessions, revokeSession } from '../services/session.service.js';
import { listSecurityEvents, recordSecurityEvent } from '../services/security.service.js';
import { emitToUser } from '../realtime/emitter.js';

export const userRouter: Router = Router();

userRouter.use(requireAuth());

userRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    const user = await findUserById(req.auth!.user.id);
    if (!user) throw notFound('Account not found.');
    const privacy = await getPrivacy(user.id);
    res.json({ user: toSelfProfile(user, privacy, decryptField(user.recovery_email_enc)) });
  }),
);

userRouter.patch(
  '/me',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        displayName: z.string().trim().min(1).max(60).optional(),
        bio: z.string().trim().max(400).optional(),
      }),
      req.body,
    );

    const updates: string[] = [];
    const params: unknown[] = [req.auth!.user.id];
    if (body.displayName !== undefined) {
      params.push(body.displayName);
      updates.push(`display_name = $${params.length}`);
    }
    if (body.bio !== undefined) {
      params.push(body.bio);
      updates.push(`bio = $${params.length}`);
    }
    if (updates.length > 0) {
      await query(`UPDATE users SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`, params);
    }

    const user = await findUserById(req.auth!.user.id);
    const privacy = await getPrivacy(user!.id);
    res.json({ user: toSelfProfile(user!, privacy, decryptField(user!.recovery_email_enc)) });
  }),
);

const visibility = z.enum(['everyone', 'contacts', 'nobody']);

userRouter.patch(
  '/me/privacy',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        whoCanContact: z.enum(['everyone', 'approved', 'nobody']).optional(),
        onlineStatusVisible: visibility.optional(),
        lastSeenVisible: visibility.optional(),
        avatarVisible: visibility.optional(),
        profileVisible: visibility.optional(),
        discoverable: z.boolean().optional(),
        readReceipts: z.boolean().optional(),
        typingIndicators: z.boolean().optional(),
      }),
      req.body,
    );

    const columns: Record<string, string> = {
      whoCanContact: 'who_can_contact',
      onlineStatusVisible: 'online_status_visible',
      lastSeenVisible: 'last_seen_visible',
      avatarVisible: 'avatar_visible',
      profileVisible: 'profile_visible',
      discoverable: 'discoverable',
      readReceipts: 'read_receipts',
      typingIndicators: 'typing_indicators',
    };

    await getPrivacy(req.auth!.user.id);
    const sets: string[] = [];
    const params: unknown[] = [req.auth!.user.id];
    for (const [key, column] of Object.entries(columns)) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (sets.length > 0) {
      await query(
        `UPDATE privacy_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`,
        params,
      );
      await recordSecurityEvent(req.auth!.user.id, 'privacy.updated', req, { fields: Object.keys(body) });
    }

    const user = await findUserById(req.auth!.user.id);
    const privacy = await getPrivacy(req.auth!.user.id);
    res.json({ user: toSelfProfile(user!, privacy, decryptField(user!.recovery_email_enc)) });
  }),
);

/** Publishes a rotated identity key. Existing messages stay sealed to the previous key. */
userRouter.put(
  '/me/keys',
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        publicKey: z.string().min(8).max(256),
        encryptedPrivateKey: z.string().min(8).max(4096),
      }),
      req.body,
    );
    await query(
      'UPDATE users SET public_key = $2, encrypted_private_key = $3, updated_at = now() WHERE id = $1',
      [req.auth!.user.id, body.publicKey, body.encryptedPrivateKey],
    );
    await recordSecurityEvent(req.auth!.user.id, 'keys.rotated', req, {}, 'warning');
    res.json({ ok: true });
  }),
);

userRouter.get(
  '/search',
  limiters.search,
  asyncRoute(async (req, res) => {
    const { q, limit } = parseQuery(
      z.object({
        q: z.string().trim().min(2).max(120),
        limit: z.coerce.number().int().min(1).max(25).default(10),
      }),
      req.query,
    );
    const rows = await searchDirectory(req.auth!.user.id, q, limit);
    const results = await Promise.all(rows.map((row) => toPublicProfile(row, req.auth!.user.id)));
    res.json({ results });
  }),
);

/** Exact-identity lookup: `alex` or `alex@veylo.chat`. Honours the discovery setting. */
userRouter.get(
  '/lookup',
  limiters.search,
  asyncRoute(async (req, res) => {
    const { identifier } = parseQuery(
      z.object({ identifier: z.string().trim().min(1).max(320) }),
      req.query,
    );
    const user = await findUserByIdentifier(identifier);
    if (!user || user.status !== 'active') throw notFound('No account uses that identity.');

    const privacy = await getPrivacy(user.id);
    if (!privacy.discoverable && user.id !== req.auth!.user.id) {
      throw notFound('No account uses that identity.');
    }
    res.json({ user: await toPublicProfile(user, req.auth!.user.id) });
  }),
);

userRouter.get(
  '/sessions',
  asyncRoute(async (req, res) => {
    const sessions = await listSessions(req.auth!.user.id);
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        device: s.device_label,
        createdAt: new Date(s.created_at).toISOString(),
        lastActiveAt: new Date(s.last_active_at).toISOString(),
        expiresAt: new Date(s.expires_at).toISOString(),
        current: s.id === req.auth!.sessionId,
      })),
    });
  }),
);

userRouter.delete(
  '/sessions/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: z.string().uuid() }), req.params);
    const revoked = await revokeSession(id, req.auth!.user.id);
    if (!revoked) throw notFound('That session is no longer active.');
    await recordSecurityEvent(req.auth!.user.id, 'session.revoked', req, { sessionId: id }, 'warning');
    res.json({ ok: true });
  }),
);

userRouter.get(
  '/security-events',
  asyncRoute(async (req, res) => {
    res.json({ events: await listSecurityEvents(req.auth!.user.id, 60) });
  }),
);

/** Presence heartbeat for clients without an open socket (e.g. a backgrounded tab). */
userRouter.post(
  '/me/presence',
  asyncRoute(async (req, res) => {
    const { presence } = parseBody(z.object({ presence: z.enum(['online', 'away', 'offline']) }), req.body);
    await query('UPDATE users SET presence = $2, last_seen_at = now() WHERE id = $1', [
      req.auth!.user.id,
      presence,
    ]);
    const contacts = await one<{ ids: string[] }>(
      "SELECT coalesce(array_agg(contact_id::text), '{}') AS ids FROM contacts WHERE user_id = $1",
      [req.auth!.user.id],
    );
    for (const contactId of contacts?.ids ?? []) {
      emitToUser(contactId, 'presence:update', { userId: req.auth!.user.id, presence });
    }
    res.json({ ok: true });
  }),
);

// Declared last so it cannot shadow /me, /search, /lookup or /sessions.
userRouter.get(
  '/:username',
  asyncRoute(async (req, res) => {
    const { username } = parseQuery(z.object({ username: z.string().trim().min(1).max(320) }), req.params);
    const user = await findUserByIdentifier(username);
    if (!user) throw notFound('No account uses that identity.');
    res.json({ user: await toPublicProfile(user, req.auth!.user.id) });
  }),
);
