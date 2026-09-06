import { many, one, query } from '../db/pool.js';
import { env } from '../config/env.js';
import type { PrivacySettingsRow, UserRow, Visibility } from '../types.js';

export interface PublicProfile {
  id: string;
  username: string;
  customAddress: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  publicKey: string | null;
  presence: 'online' | 'away' | 'offline' | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  isContact: boolean;
  isBlocked: boolean;
  hasBlockedYou: boolean;
  canMessage: boolean;
  accountStatus: 'active' | 'suspended' | 'banned' | 'deleted';
}

export function avatarUrl(key: string | null): string | null {
  return key ? `${env.API_URL}/api/files/${encodeURIComponent(key)}` : null;
}

export function buildCustomAddress(username: string): string {
  return `${username.toLowerCase()}@${env.IDENTITY_DOMAIN}`;
}

/** Accepts either a username or a full custom address and returns the bare username. */
export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  return at === -1 ? trimmed : trimmed.slice(0, at);
}

export async function findUserByIdentifier(identifier: string): Promise<UserRow | null> {
  const username = normalizeIdentifier(identifier);
  return one<UserRow>(
    `SELECT * FROM users WHERE username = $1 AND deleted_at IS NULL LIMIT 1`,
    [username],
  );
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
}

export async function getPrivacy(userId: string): Promise<PrivacySettingsRow> {
  const row = await one<PrivacySettingsRow>('SELECT * FROM privacy_settings WHERE user_id = $1', [userId]);
  if (row) return row;
  const created = await one<PrivacySettingsRow>(
    'INSERT INTO privacy_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING *',
    [userId],
  );
  return created!;
}

export async function areContacts(a: string, b: string): Promise<boolean> {
  const row = await one('SELECT 1 FROM contacts WHERE user_id = $1 AND contact_id = $2', [a, b]);
  return row !== null;
}

export async function addContactEdge(a: string, b: string): Promise<void> {
  await query(
    `INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2), ($2, $1)
     ON CONFLICT DO NOTHING`,
    [a, b],
  );
}

export async function removeContactEdge(a: string, b: string): Promise<void> {
  await query(
    'DELETE FROM contacts WHERE (user_id = $1 AND contact_id = $2) OR (user_id = $2 AND contact_id = $1)',
    [a, b],
  );
}

export interface BlockState {
  viewerBlockedTarget: boolean;
  targetBlockedViewer: boolean;
  either: boolean;
}

export async function blockState(viewerId: string, targetId: string): Promise<BlockState> {
  if (viewerId === targetId) return { viewerBlockedTarget: false, targetBlockedViewer: false, either: false };
  const rows = await many<{ blocker_id: string }>(
    `SELECT blocker_id FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [viewerId, targetId],
  );
  const viewerBlockedTarget = rows.some((r) => r.blocker_id === viewerId);
  const targetBlockedViewer = rows.some((r) => r.blocker_id === targetId);
  return { viewerBlockedTarget, targetBlockedViewer, either: viewerBlockedTarget || targetBlockedViewer };
}

function allows(setting: Visibility, isSelf: boolean, isContact: boolean): boolean {
  if (isSelf) return true;
  if (setting === 'everyone') return true;
  if (setting === 'contacts') return isContact;
  return false;
}

/**
 * Renders a profile through the target's privacy settings. Every field the target chose to
 * hide comes back null rather than being omitted, so clients render consistently and cannot
 * infer the hidden value from the response shape.
 */
export async function toPublicProfile(
  target: UserRow,
  viewerId: string | null,
): Promise<PublicProfile> {
  const isSelf = viewerId === target.id;
  const privacy = await getPrivacy(target.id);
  const isContact = !isSelf && viewerId ? await areContacts(viewerId, target.id) : false;
  const blocks = viewerId && !isSelf
    ? await blockState(viewerId, target.id)
    : { viewerBlockedTarget: false, targetBlockedViewer: false, either: false };

  const profileVisible = allows(privacy.profile_visible, isSelf, isContact);
  const showPresence = !blocks.either && allows(privacy.online_status_visible, isSelf, isContact);
  const showLastSeen = !blocks.either && allows(privacy.last_seen_visible, isSelf, isContact);
  const showAvatar = !blocks.either && allows(privacy.avatar_visible, isSelf, isContact);

  // "approved" still permits an approach — it just files a request first.
  const canMessage =
    !isSelf && !blocks.either && target.status === 'active' && privacy.who_can_contact !== 'nobody';

  return {
    id: target.id,
    username: target.username,
    customAddress: target.custom_address,
    displayName: target.display_name,
    avatarUrl: showAvatar ? avatarUrl(target.avatar_key) : null,
    bio: profileVisible ? target.bio : '',
    publicKey: target.public_key,
    presence: showPresence ? target.presence : null,
    lastSeenAt: showLastSeen && target.last_seen_at ? new Date(target.last_seen_at).toISOString() : null,
    createdAt: profileVisible ? new Date(target.created_at).toISOString() : null,
    isContact,
    isBlocked: blocks.viewerBlockedTarget,
    hasBlockedYou: false, // never disclosed: a blocked user must not be able to detect the block
    canMessage,
    accountStatus: target.status,
  };
}

/** The signed-in user's own record, including fields no one else may see. */
export function toSelfProfile(user: UserRow, privacy: PrivacySettingsRow, recoveryEmail: string | null) {
  return {
    id: user.id,
    username: user.username,
    customAddress: user.custom_address,
    displayName: user.display_name,
    avatarUrl: avatarUrl(user.avatar_key),
    bio: user.bio,
    publicKey: user.public_key,
    encryptedPrivateKey: user.encrypted_private_key,
    presence: user.presence,
    lastSeenAt: user.last_seen_at ? new Date(user.last_seen_at).toISOString() : null,
    role: user.role,
    accountStatus: user.status,
    createdAt: new Date(user.created_at).toISOString(),
    recoveryEmail,
    recoveryEmailVerified: user.recovery_email_verified,
    privacy: {
      whoCanContact: privacy.who_can_contact,
      onlineStatusVisible: privacy.online_status_visible,
      lastSeenVisible: privacy.last_seen_visible,
      avatarVisible: privacy.avatar_visible,
      profileVisible: privacy.profile_visible,
      discoverable: privacy.discoverable,
      readReceipts: privacy.read_receipts,
      typingIndicators: privacy.typing_indicators,
    },
  };
}

/**
 * Directory search across username, custom address and display name.
 *
 * Only accounts that opted into discovery are returned, blocks are filtered out in SQL, and
 * results are capped. Conversations and messages are never searched here.
 */
export async function searchDirectory(viewerId: string, term: string, limit: number): Promise<UserRow[]> {
  const cleaned = term.trim().toLowerCase();
  if (cleaned.length < 2) return [];
  const bare = normalizeIdentifier(cleaned);
  const pattern = `%${cleaned.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const barePattern = `%${bare.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

  return many<UserRow>(
    `SELECT u.* FROM users u
       JOIN privacy_settings p ON p.user_id = u.id
      WHERE u.deleted_at IS NULL
        AND u.status = 'active'
        AND u.id <> $1
        AND p.discoverable = TRUE
        AND (u.username LIKE $2 ESCAPE '\\'
             OR u.custom_address LIKE $3 ESCAPE '\\'
             OR lower(u.display_name) LIKE $3 ESCAPE '\\')
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
        )
      ORDER BY (u.username = $4) DESC, (u.custom_address = $5) DESC, length(u.username), u.username
      LIMIT $6`,
    [viewerId, barePattern, pattern, bare, cleaned, limit],
  );
}

export async function setPresence(userId: string, presence: 'online' | 'away' | 'offline'): Promise<void> {
  await query(
    `UPDATE users SET presence = $2, last_seen_at = now(), updated_at = now() WHERE id = $1`,
    [userId, presence],
  );
}
