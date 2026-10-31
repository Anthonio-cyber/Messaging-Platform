import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
import { many, one, query, transaction } from '../db/pool.js';
import {
  blindIndex,
  encryptField,
  generateToken,
  hashToken,
  randomUUID,
} from '../lib/crypto.js';
import { fakeVerify, generateSalt, hashSecret, verifySecret } from '../lib/password.js';
import { badRequest, conflict, forbidden, notFound, rateLimited, unauthorized } from '../lib/errors.js';
import { buildCustomAddress, findUserByIdentifier, normalizeIdentifier } from './user.service.js';
import { isBruteForced, recordLoginAttempt, recordSecurityEvent } from './security.service.js';
import type { UserRow } from '../types.js';

/**
 * How authentication works
 * ------------------------
 * The browser never sends the password. It derives two independent keys with Argon2id:
 *
 *   authenticator = Argon2id(password, auth_salt)   -> sent to the server
 *   vaultKey      = Argon2id(password, vault_salt)  -> never leaves the device
 *
 * The server treats `authenticator` as an opaque secret and stores only scrypt(authenticator).
 * `vaultKey` unwraps the user's X25519 private key, which is what makes message history
 * readable. Because the server never sees the password or the vault key, it cannot read
 * message content even with full database access.
 */

const RESET_TTL_MINUTES = 30;
const VERIFY_TTL_HOURS = 24;

export interface RegistrationInput {
  username: string;
  displayName: string;
  authenticator: string;
  authSalt: string;
  vaultSalt: string;
  publicKey: string;
  encryptedPrivateKey: string;
  recoveryEmail?: string | null;
}

export async function isUsernameAvailable(username: string): Promise<{ available: boolean; reason?: string }> {
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_.-]{1,30})[a-z0-9]$/.test(normalized)) {
    return {
      available: false,
      reason: 'Use 3-32 characters: letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.',
    };
  }
  const reserved = await one('SELECT 1 FROM reserved_usernames WHERE username = $1', [normalized]);
  if (reserved) return { available: false, reason: 'That name is reserved.' };

  const taken = await one('SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL', [normalized]);
  if (taken) return { available: false, reason: 'That name is already taken.' };

  return { available: true };
}

export async function register(input: RegistrationInput, req: Request): Promise<UserRow> {
  const username = input.username.trim().toLowerCase();
  const availability = await isUsernameAvailable(username);
  if (!availability.available) throw conflict(availability.reason ?? 'That username cannot be used.');

  const passwordHash = await hashSecret(input.authenticator);
  const recoveryEmail = input.recoveryEmail?.trim().toLowerCase() || null;

  const user = await transaction(async (client) => {
    const created = await client.query<UserRow>(
      `INSERT INTO users (
         username, custom_address, display_name, password_hash, auth_salt, vault_salt,
         public_key, encrypted_private_key, recovery_email_enc, recovery_email_index
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        username,
        buildCustomAddress(username),
        input.displayName.trim(),
        passwordHash,
        input.authSalt,
        input.vaultSalt,
        input.publicKey,
        input.encryptedPrivateKey,
        recoveryEmail ? encryptField(recoveryEmail) : null,
        recoveryEmail ? blindIndex(recoveryEmail) : null,
      ],
    );
    const row = created.rows[0]!;
    await client.query('INSERT INTO privacy_settings (user_id) VALUES ($1)', [row.id]);
    return row;
  });

  // First-boot bootstrap: promotes exactly one configured identity to admin.
  if (
    env.ADMIN_BOOTSTRAP_ADDRESS &&
    normalizeIdentifier(env.ADMIN_BOOTSTRAP_ADDRESS) === username
  ) {
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    user.role = 'admin';
    await recordSecurityEvent(user.id, 'admin.bootstrap', req, {}, 'critical');
  }

  await recordSecurityEvent(user.id, 'account.created', req, { username });
  return user;
}

/**
 * Returns the salts a client needs to derive its keys.
 *
 * For identities that do not exist we return stable, deterministic pseudo-salts derived from
 * AUTH_SECRET. They look exactly like real ones and never change, so this endpoint cannot be
 * used to enumerate accounts.
 */
export async function getLoginSalts(identifier: string): Promise<{ authSalt: string; vaultSalt: string }> {
  const username = normalizeIdentifier(identifier);
  const user = await one<{ auth_salt: string; vault_salt: string }>(
    'SELECT auth_salt, vault_salt FROM users WHERE username = $1 AND deleted_at IS NULL',
    [username],
  );
  if (user) return { authSalt: user.auth_salt, vaultSalt: user.vault_salt };

  const decoy = (label: string) =>
    createHmac('sha256', env.AUTH_SECRET).update(`decoy:${label}:${username}`).digest().subarray(0, 16).toString('base64');
  return { authSalt: decoy('auth'), vaultSalt: decoy('vault') };
}

export interface LoginResult {
  user: UserRow;
}

export async function login(identifier: string, authenticator: string, req: Request): Promise<LoginResult> {
  if (await isBruteForced(identifier, req)) {
    await recordSecurityEvent(null, 'auth.brute_force_blocked', req, {}, 'warning');
    throw rateLimited('Too many failed sign-in attempts. Wait 15 minutes before trying again.');
  }

  const user = await findUserByIdentifier(identifier);

  if (!user) {
    // Spend comparable CPU so response time does not reveal that the account is missing.
    await fakeVerify();
    await recordLoginAttempt(identifier, null, req, false);
    throw unauthorized('That identity or password is not correct.');
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await recordLoginAttempt(identifier, user.id, req, false);
    throw rateLimited('This account is temporarily locked after repeated failed sign-ins.');
  }

  const valid = await verifySecret(authenticator, user.password_hash);

  if (!valid) {
    const failures = user.failed_login_count + 1;
    const lockFor = failures >= 10 ? "interval '15 minutes'" : 'NULL';
    await query(
      `UPDATE users SET failed_login_count = $2, locked_until = now() + ${lockFor} WHERE id = $1`,
      [user.id, failures],
    );
    await recordLoginAttempt(identifier, user.id, req, false);
    await recordSecurityEvent(user.id, 'auth.failed_login', req, { failures }, failures >= 5 ? 'warning' : 'info');
    throw unauthorized('That identity or password is not correct.');
  }

  if (user.status === 'banned') {
    await recordLoginAttempt(identifier, user.id, req, false);
    throw forbidden('This account has been permanently disabled for breaking the community rules.');
  }
  if (user.status === 'deleted') {
    throw unauthorized('That identity or password is not correct.');
  }
  if (user.status === 'suspended') {
    const until = user.suspended_until ? new Date(user.suspended_until) : null;
    if (!until || until > new Date()) {
      await recordLoginAttempt(identifier, user.id, req, false);
      throw forbidden(
        until
          ? `This account is suspended until ${until.toISOString().slice(0, 10)}.`
          : 'This account is suspended.',
      );
    }
    // Suspension has lapsed — restore automatically.
    await query("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1", [user.id]);
    user.status = 'active';
  }

  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  await recordLoginAttempt(identifier, user.id, req, true);
  return { user };
}

export async function changePassword(
  userId: string,
  currentAuthenticator: string,
  next: { authenticator: string; authSalt: string; vaultSalt: string; encryptedPrivateKey: string },
  req: Request,
): Promise<void> {
  const user = await one<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!user) throw notFound('Account not found.');

  if (!(await verifySecret(currentAuthenticator, user.password_hash))) {
    await recordSecurityEvent(userId, 'auth.password_change_failed', req, {}, 'warning');
    throw unauthorized('Your current password is not correct.');
  }

  const passwordHash = await hashSecret(next.authenticator);
  await query(
    `UPDATE users
        SET password_hash = $2, auth_salt = $3, vault_salt = $4,
            encrypted_private_key = $5, password_changed_at = now(), updated_at = now()
      WHERE id = $1`,
    [userId, passwordHash, next.authSalt, next.vaultSalt, next.encryptedPrivateKey],
  );
  await recordSecurityEvent(userId, 'auth.password_changed', req, {}, 'warning');
}

export interface ResetTicket {
  token: string;
  expiresAt: Date;
}

export async function createPasswordResetToken(userId: string): Promise<ResetTicket> {
  // Only one live reset at a time.
  await query(
    "UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL",
    [userId],
  );
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset',$2,$3)`,
    [userId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

export const passwordResetTtlMinutes = RESET_TTL_MINUTES;

export async function consumePasswordReset(
  token: string,
  next: {
    authenticator: string;
    authSalt: string;
    vaultSalt: string;
    encryptedPrivateKey: string;
    publicKey?: string;
  },
  req: Request,
): Promise<string> {
  const row = await one<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM auth_tokens
      WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) throw badRequest('This reset link has expired or has already been used. Request a new one.');

  const passwordHash = await hashSecret(next.authenticator);

  await transaction(async (client) => {
    await client.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
    await client.query(
      `UPDATE users
          SET password_hash = $2, auth_salt = $3, vault_salt = $4,
              encrypted_private_key = $5,
              public_key = COALESCE($6, public_key),
              password_changed_at = now(), failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [row.user_id, passwordHash, next.authSalt, next.vaultSalt, next.encryptedPrivateKey, next.publicKey ?? null],
    );
    // A reset invalidates every existing device session.
    await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      row.user_id,
    ]);
  });

  await recordSecurityEvent(row.user_id, 'auth.password_reset', req, {}, 'critical');
  return row.user_id;
}

export async function findUserByRecoveryEmail(email: string): Promise<UserRow | null> {
  return one<UserRow>(
    `SELECT * FROM users
      WHERE recovery_email_index = $1 AND recovery_email_verified = TRUE AND deleted_at IS NULL
      LIMIT 1`,
    [blindIndex(email)],
  );
}

export async function createEmailVerificationToken(userId: string, email: string): Promise<ResetTicket> {
  await query(
    "UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'email_verify' AND used_at IS NULL",
    [userId],
  );
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_HOURS * 3600 * 1000);
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, payload, expires_at)
     VALUES ($1,'email_verify',$2,$3,$4)`,
    [userId, hashToken(token), JSON.stringify({ index: blindIndex(email) }), expiresAt],
  );
  return { token, expiresAt };
}

export async function consumeEmailVerification(token: string): Promise<string> {
  const row = await one<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM auth_tokens
      WHERE token_hash = $1 AND purpose = 'email_verify' AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) throw badRequest('This confirmation link has expired or has already been used.');

  await transaction(async (client) => {
    await client.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
    await client.query('UPDATE users SET recovery_email_verified = TRUE, updated_at = now() WHERE id = $1', [
      row.user_id,
    ]);
  });
  return row.user_id;
}

export interface GeneratedRecoveryCode {
  code: string;
  wrappedVaultKey: string;
}

/** Replaces the whole set: generating new codes invalidates every previous code. */
export async function storeRecoveryCodes(userId: string, codes: GeneratedRecoveryCode[]): Promise<void> {
  await transaction(async (client) => {
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    for (const entry of codes) {
      await client.query(
        'INSERT INTO recovery_codes (user_id, code_hash, wrapped_vault_key) VALUES ($1, $2, $3)',
        [userId, hashToken(entry.code), entry.wrappedVaultKey],
      );
    }
  });
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const row = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return row?.count ?? 0;
}

/** Redeems a recovery code and hands back the sealed vault key so history survives a reset. */
export async function redeemRecoveryCode(
  userId: string,
  code: string,
): Promise<{ wrappedVaultKey: string | null }> {
  const row = await one<{ id: string; wrapped_vault_key: string | null }>(
    `SELECT id, wrapped_vault_key FROM recovery_codes
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hashToken(code.trim().replace(/\s+/g, '').toLowerCase())],
  );
  if (!row) throw badRequest('That recovery code is not valid or has already been used.');
  await query('UPDATE recovery_codes SET used_at = now() WHERE id = $1', [row.id]);
  return { wrappedVaultKey: row.wrapped_vault_key };
}

/**
 * Soft-deletes an account: scrubs identifying columns, frees nothing that would let another
 * person claim the identity, revokes sessions and drops social edges. Message ciphertext in
 * other people's conversations is left intact — it is their data too, and unreadable here.
 */
export async function deleteAccount(userId: string, req: Request): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `UPDATE users
          SET status = 'deleted', deleted_at = now(),
              display_name = 'Deleted account',
              bio = '', avatar_key = NULL,
              recovery_email_enc = NULL, recovery_email_index = NULL, recovery_email_verified = FALSE,
              public_key = NULL, encrypted_private_key = NULL,
              presence = 'offline', updated_at = now()
        WHERE id = $1`,
      [userId],
    );
    await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM contacts WHERE user_id = $1 OR contact_id = $1', [userId]);
    await client.query('UPDATE conversation_members SET left_at = now(), is_active = FALSE WHERE user_id = $1', [
      userId,
    ]);
  });
  await recordSecurityEvent(userId, 'account.deleted', req, {}, 'critical');
}

export async function listActiveResetTokens(userId: string) {
  return many('SELECT id, purpose, expires_at FROM auth_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
}

export { randomUUID, generateSalt };
