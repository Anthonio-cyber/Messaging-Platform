import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncRoute, deviceLabel, parseBody, parseQuery, userAgent } from '../lib/http.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { blindIndex, decryptField, encryptField, hashToken } from '../lib/crypto.js';
import { sendMail, templates } from '../lib/mailer.js';
import { query, one } from '../db/pool.js';
import { verifySecret } from '../lib/password.js';
import { limiters } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { issueCsrfCookie } from '../middleware/security.js';
import * as auth from '../services/auth.service.js';
import {
  clearSessionCookie,
  createSession,
  revokeAllSessions,
  setSessionCookie,
} from '../services/session.service.js';
import { getPrivacy, findUserById, toSelfProfile } from '../services/user.service.js';
import { notifyNewLogin, isUnfamiliarLogin, recordSecurityEvent } from '../services/security.service.js';
import { disconnectUserSockets } from '../realtime/emitter.js';
import type { UserRow } from '../types.js';

export const authRouter: Router = Router();

// Base64 blobs produced by the browser's crypto layer.
const b64 = (max: number) =>
  z.string().min(8).max(max).regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'Expected base64 data');

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Usernames need at least 3 characters.')
  .max(32, 'Usernames can be at most 32 characters.');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

const keyMaterialSchema = z.object({
  authenticator: b64(512),
  authSalt: b64(128),
  vaultSalt: b64(128),
  encryptedPrivateKey: b64(4096),
});

/** Hands the browser a CSRF token before it makes its first state-changing call. */
authRouter.get('/csrf', (req, res) => {
  const token = issueCsrfCookie(res);
  res.json({ csrfToken: token });
});

authRouter.get(
  '/availability',
  asyncRoute(async (req, res) => {
    const { username } = parseQuery(z.object({ username: usernameSchema }), req.query);
    const result = await auth.isUsernameAvailable(username);
    res.json({
      username,
      customAddress: `${username}@${env.IDENTITY_DOMAIN}`,
      available: result.available,
      reason: result.reason ?? null,
    });
  }),
);

/**
 * Registration. The browser has already derived `authenticator` (Argon2id over the password)
 * and generated an X25519 identity key whose private half is sealed with the vault key.
 * The raw password never reaches this endpoint.
 */
authRouter.post(
  '/register',
  limiters.register,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      keyMaterialSchema.extend({
        username: usernameSchema,
        displayName: z.string().trim().min(1, 'Add a display name.').max(60),
        publicKey: b64(256),
        recoveryEmail: emailSchema.optional().nullable(),
      }),
      req.body,
    );

    const user = await auth.register(body, req);
    const session = await createSession(user.id, req);
    setSessionCookie(res, session.token, session.expiresAt);
    const csrfToken = issueCsrfCookie(res);

    if (body.recoveryEmail) {
      const ticket = await auth.createEmailVerificationToken(user.id, body.recoveryEmail);
      const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(ticket.token)}`;
      const mail = templates.verifyEmail(link);
      await sendMail({ ...mail, to: body.recoveryEmail });
    }

    const privacy = await getPrivacy(user.id);
    res.status(201).json({
      user: toSelfProfile(user, privacy, body.recoveryEmail ?? null),
      csrfToken,
      identityDomain: env.IDENTITY_DOMAIN,
    });
  }),
);

/**
 * Returns the key-derivation salts for an identity. Unknown identities get stable decoy salts,
 * so this cannot be used to discover which accounts exist.
 */
authRouter.post(
  '/salt',
  limiters.saltLookup,
  asyncRoute(async (req, res) => {
    const { identifier } = parseBody(z.object({ identifier: z.string().trim().min(1).max(320) }), req.body);
    const salts = await auth.getLoginSalts(identifier);
    res.json(salts);
  }),
);

authRouter.post(
  '/login',
  limiters.signIn,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ identifier: z.string().trim().min(1).max(320), authenticator: b64(512) }),
      req.body,
    );

    const { user } = await auth.login(body.identifier, body.authenticator, req);
    const unfamiliar = await isUnfamiliarLogin(user.id, req);
    const session = await createSession(user.id, req);
    setSessionCookie(res, session.token, session.expiresAt);
    const csrfToken = issueCsrfCookie(res);

    const label = deviceLabel(userAgent(req));
    await recordSecurityEvent(user.id, 'auth.login', req, { device: label }, unfamiliar ? 'warning' : 'info');
    void notifyNewLogin(user.id, label, user.recovery_email_enc, unfamiliar);

    const privacy = await getPrivacy(user.id);
    res.json({
      user: toSelfProfile(user, privacy, decryptField(user.recovery_email_enc)),
      csrfToken,
      identityDomain: env.IDENTITY_DOMAIN,
      unfamiliarDevice: unfamiliar,
    });
  }),
);

authRouter.post(
  '/logout',
  asyncRoute(async (req, res) => {
    if (req.auth) {
      await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
      await recordSecurityEvent(req.auth.user.id, 'auth.logout', req);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout-all',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const userId = req.auth!.user.id;
    const count = await revokeAllSessions(userId);
    await disconnectUserSockets(userId);
    await recordSecurityEvent(userId, 'auth.logout_all', req, { count }, 'warning');
    clearSessionCookie(res);
    res.json({ ok: true, revoked: count });
  }),
);

authRouter.get(
  '/session',
  asyncRoute(async (req, res) => {
    if (!req.auth) {
      res.json({ user: null, identityDomain: env.IDENTITY_DOMAIN });
      return;
    }
    const user = await findUserById(req.auth.user.id);
    if (!user) {
      clearSessionCookie(res);
      res.json({ user: null, identityDomain: env.IDENTITY_DOMAIN });
      return;
    }
    const privacy = await getPrivacy(user.id);
    res.json({
      user: toSelfProfile(user, privacy, decryptField(user.recovery_email_enc)),
      identityDomain: env.IDENTITY_DOMAIN,
    });
  }),
);

authRouter.post(
  '/password/change',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      keyMaterialSchema.extend({ currentAuthenticator: b64(512) }),
      req.body,
    );
    const userId = req.auth!.user.id;
    await auth.changePassword(userId, body.currentAuthenticator, body, req);
    // Keep the device that made the change signed in; drop every other one.
    await revokeAllSessions(userId, req.auth!.sessionId);
    res.json({ ok: true });
  }),
);

/**
 * Password reset request. Always responds identically, whether or not a verified recovery
 * address exists, so the endpoint cannot confirm an account or an email address.
 */
authRouter.post(
  '/password/forgot',
  limiters.passwordReset,
  asyncRoute(async (req, res) => {
    const { email } = parseBody(z.object({ email: emailSchema }), req.body);
    const user = await auth.findUserByRecoveryEmail(email);

    if (user) {
      const ticket = await auth.createPasswordResetToken(user.id);
      const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(ticket.token)}`;
      const mail = templates.passwordReset(link, auth.passwordResetTtlMinutes);
      await sendMail({ ...mail, to: email });
      await recordSecurityEvent(user.id, 'auth.password_reset_requested', req, {}, 'warning');
    }

    res.json({
      ok: true,
      message: 'If that address is on file as a verified recovery address, a reset link is on its way.',
    });
  }),
);

/**
 * Salts for a reset flow. The client needs the account's vault salt to re-seal the identity
 * key; holding a valid reset token is what authorises the lookup.
 */
authRouter.post(
  '/password/reset/context',
  asyncRoute(async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().min(10).max(200) }), req.body);
    const row = await one<{ user_id: string; username: string; vault_salt: string; recovery_codes: number }>(
      `SELECT t.user_id, u.username, u.vault_salt,
              (SELECT count(*)::int FROM recovery_codes rc WHERE rc.user_id = u.id AND rc.used_at IS NULL) AS recovery_codes
         FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.purpose = 'password_reset' AND t.used_at IS NULL AND t.expires_at > now()`,
      [hashToken(token)],
    );
    if (!row) throw badRequest('This reset link has expired or has already been used.');
    res.json({
      username: row.username,
      currentVaultSalt: row.vault_salt,
      recoveryCodesAvailable: Number(row.recovery_codes) > 0,
    });
  }),
);

authRouter.post(
  '/password/reset',
  limiters.passwordReset,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      keyMaterialSchema.extend({
        token: z.string().min(10).max(200),
        publicKey: b64(256).optional(),
      }),
      req.body,
    );
    const userId = await auth.consumePasswordReset(body.token, body, req);
    await disconnectUserSockets(userId);
    res.json({ ok: true });
  }),
);

/** Redeems a recovery code during a reset so end-to-end encrypted history stays readable. */
authRouter.post(
  '/recovery/redeem',
  limiters.passwordReset,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ token: z.string().min(10).max(200), code: z.string().min(6).max(64) }),
      req.body,
    );
    const row = await one<{ user_id: string }>(
      `SELECT user_id FROM auth_tokens
        WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now()`,
      [hashToken(body.token)],
    );
    if (!row) throw badRequest('This reset link has expired or has already been used.');

    const result = await auth.redeemRecoveryCode(row.user_id, body.code);
    await recordSecurityEvent(row.user_id, 'auth.recovery_code_used', req, {}, 'critical');
    res.json({ wrappedVaultKey: result.wrappedVaultKey });
  }),
);

authRouter.post(
  '/recovery/codes',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        codes: z
          .array(z.object({ code: z.string().min(6).max(64), wrappedVaultKey: b64(1024) }))
          .min(4)
          .max(16),
      }),
      req.body,
    );
    await auth.storeRecoveryCodes(req.auth!.user.id, body.codes);
    await recordSecurityEvent(req.auth!.user.id, 'auth.recovery_codes_generated', req, {}, 'warning');
    res.json({ ok: true, remaining: body.codes.length });
  }),
);

authRouter.get(
  '/recovery/codes',
  requireAuth(),
  asyncRoute(async (req, res) => {
    res.json({ remaining: await auth.countUnusedRecoveryCodes(req.auth!.user.id) });
  }),
);

authRouter.post(
  '/email/set',
  requireAuth(),
  limiters.passwordReset,
  asyncRoute(async (req, res) => {
    const { email } = parseBody(z.object({ email: emailSchema }), req.body);
    const userId = req.auth!.user.id;
    await query(
      `UPDATE users SET recovery_email_enc = $2, recovery_email_index = $3,
              recovery_email_verified = FALSE, updated_at = now()
        WHERE id = $1`,
      [userId, encryptField(email), blindIndex(email)],
    );
    const ticket = await auth.createEmailVerificationToken(userId, email);
    const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(ticket.token)}`;
    const mail = templates.verifyEmail(link);
    const delivery = await sendMail({ ...mail, to: email });
    await recordSecurityEvent(userId, 'account.recovery_email_set', req, {}, 'warning');
    res.json({ ok: true, delivered: delivery.delivered });
  }),
);

authRouter.post(
  '/email/verify',
  asyncRoute(async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().min(10).max(200) }), req.body);
    await auth.consumeEmailVerification(token);
    res.json({ ok: true });
  }),
);

authRouter.delete(
  '/account',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({ authenticator: b64(512), confirmation: z.literal('DELETE') }),
      req.body,
    );
    const userId = req.auth!.user.id;
    const user = await one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) throw notFound('Account not found.');

    if (!(await verifySecret(body.authenticator, user.password_hash))) {
      throw unauthorized('Your password is not correct.');
    }

    await auth.deleteAccount(userId, req);
    await disconnectUserSockets(userId);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);
