import { many, one, query, transaction } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { storage } from '../lib/storage.js';
import { getPrivacy } from './user.service.js';
import { emitToUser } from '../realtime/emitter.js';

/**
 * Status posts.
 *
 * A status is encrypted exactly as a group message is — one sealed copy of the content key per
 * person entitled to read it — and that single decision answers most of the design questions
 * here. Per-recipient key wrapping cannot express "everyone", so the audience is the author's
 * contacts, fixed at the moment of posting. Someone who becomes a contact tomorrow cannot read
 * today's status: no key for them exists on it, and this server could not mint one if asked.
 *
 * Everything else follows the same rule as messages. The server stores opaque bytes, decides
 * who may fetch them, and records that a fetch happened. It never learns what was posted.
 */

/** Statuses live for a day. Long enough to be seen, short enough to be worth posting casually. */
const STATUS_TTL_HOURS = 24;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;

export interface StatusKeyInput {
  userId: string;
  wrappedKey: string;
}

export interface CreateStatusInput {
  authorId: string;
  kind: 'text' | 'image';
  ciphertext: string;
  nonce: string;
  keys: StatusKeyInput[];
  mediaId?: string | null;
}

export interface StatusDto {
  id: string;
  authorId: string;
  kind: 'text' | 'image';
  ciphertext: string;
  nonce: string;
  wrappedKey: string | null;
  mediaId: string | null;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
  viewCount: number | null;
}

/**
 * The accounts entitled to a key for this author's next status: their contacts, minus anyone
 * either of them has blocked, minus anyone whose own settings refuse it. Returned with public
 * keys so the caller's device can wrap for each.
 */
export async function statusAudience(
  authorId: string,
): Promise<Array<{ userId: string; publicKey: string | null }>> {
  const privacy = await getPrivacy(authorId);
  if (privacy.status_audience === 'nobody') return [];

  return many<{ userId: string; publicKey: string | null }>(
    `SELECT u.id AS "userId", u.public_key AS "publicKey"
       FROM contacts c
       JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = $1
        AND u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
        )
      ORDER BY u.display_name`,
    [authorId],
  );
}

export async function createStatus(input: CreateStatusInput): Promise<StatusDto> {
  if (Buffer.byteLength(input.ciphertext, 'utf8') > MAX_CIPHERTEXT_BYTES) {
    throw badRequest('That status is too large to post.');
  }

  const audience = await statusAudience(input.authorId);
  // The author always gets a key: otherwise you could not re-read your own post, which is
  // where the view counts are shown.
  const allowed = new Set([input.authorId, ...audience.map((entry) => entry.userId)]);

  for (const key of input.keys) {
    if (!allowed.has(key.userId)) {
      throw forbidden('Cannot address a status key to someone outside your audience.');
    }
  }
  if (!input.keys.some((key) => key.userId === input.authorId)) {
    throw badRequest('A status must include a key for its author.');
  }

  let mediaRowId: string | null = null;
  if (input.mediaId) {
    const media = await one<{ id: string; status_id: string | null }>(
      'SELECT id, status_id FROM status_media WHERE id = $1 AND uploader_id = $2',
      [input.mediaId, input.authorId],
    );
    if (!media) throw badRequest('That upload is no longer available. Try attaching it again.');
    if (media.status_id) throw badRequest('That upload is already attached to a status.');
    mediaRowId = media.id;
  }
  if (input.kind === 'image' && !input.mediaId) {
    throw badRequest('An image status needs an uploaded image.');
  }

  const statusId = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO statuses (author_id, kind, ciphertext, nonce, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)
       RETURNING id`,
      [input.authorId, input.kind, input.ciphertext, input.nonce, String(STATUS_TTL_HOURS)],
    );
    const id = inserted.rows[0]!.id;

    for (const key of input.keys) {
      await client.query(
        'INSERT INTO status_keys (status_id, user_id, wrapped_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [id, key.userId, key.wrappedKey],
      );
    }

    if (mediaRowId) {
      await client.query('UPDATE status_media SET status_id = $1 WHERE id = $2', [id, mediaRowId]);
    }
    return id;
  });

  // Tell the audience there is something new, without saying anything about it.
  for (const key of input.keys) {
    if (key.userId !== input.authorId) emitToUser(key.userId, 'status:new', { authorId: input.authorId });
  }

  const created = await getStatusForViewer(statusId, input.authorId);
  if (!created) throw notFound('The status could not be read back.');
  return created;
}

const STATUS_SELECT = `
  SELECT s.id,
         s.author_id  AS "authorId",
         s.kind,
         s.ciphertext,
         s.nonce,
         s.created_at AS "createdAt",
         s.expires_at AS "expiresAt",
         k.wrapped_key AS "wrappedKey",
         m.id AS "mediaId",
         (v.viewer_id IS NOT NULL) AS viewed,
         CASE WHEN s.author_id = $1
              THEN (SELECT count(*) FROM status_views sv WHERE sv.status_id = s.id)
              ELSE NULL END AS "viewCount"
    FROM statuses s
    JOIN status_keys k ON k.status_id = s.id AND k.user_id = $1
    LEFT JOIN status_media m ON m.status_id = s.id
    LEFT JOIN status_views v ON v.status_id = s.id AND v.viewer_id = $1
   WHERE s.deleted_at IS NULL
     AND s.expires_at > now()`;

function toDto(row: Record<string, unknown>): StatusDto {
  return {
    id: row.id as string,
    authorId: row.authorId as string,
    kind: row.kind as 'text' | 'image',
    ciphertext: row.ciphertext as string,
    nonce: row.nonce as string,
    wrappedKey: (row.wrappedKey as string | null) ?? null,
    mediaId: (row.mediaId as string | null) ?? null,
    createdAt: new Date(row.createdAt as string).toISOString(),
    expiresAt: new Date(row.expiresAt as string).toISOString(),
    viewed: Boolean(row.viewed),
    viewCount: row.viewCount === null ? null : Number(row.viewCount),
  };
}

/**
 * Every live status this account holds a key for, including its own, newest last within each
 * author so a viewer plays them in the order they were posted.
 */
export async function listStatuses(viewerId: string): Promise<StatusDto[]> {
  const rows = await many<Record<string, unknown>>(
    `${STATUS_SELECT} ORDER BY s.created_at ASC`,
    [viewerId],
  );
  return rows.map(toDto);
}

export async function getStatusForViewer(statusId: string, viewerId: string): Promise<StatusDto | null> {
  const row = await one<Record<string, unknown>>(`${STATUS_SELECT} AND s.id = $2`, [viewerId, statusId]);
  return row ? toDto(row) : null;
}

/**
 * Records that someone opened a status.
 *
 * The author sees who viewed, but only for viewers who have read receipts on — the same trade
 * the rest of the app makes. A viewer with receipts off still has the view counted for nobody:
 * the row is simply not written, so there is nothing to leak later if the setting changes.
 */
export async function recordStatusView(statusId: string, viewerId: string): Promise<void> {
  const status = await one<{ author_id: string }>(
    `SELECT s.author_id FROM statuses s
       JOIN status_keys k ON k.status_id = s.id AND k.user_id = $2
      WHERE s.id = $1 AND s.deleted_at IS NULL AND s.expires_at > now()`,
    [statusId, viewerId],
  );
  if (!status) throw notFound('That status is no longer available.');
  if (status.author_id === viewerId) return;

  const privacy = await getPrivacy(viewerId);
  if (!privacy.read_receipts) return;

  await query(
    'INSERT INTO status_views (status_id, viewer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [statusId, viewerId],
  );
}

/** Who viewed one of your own statuses. Refuses for anyone else's. */
export async function listStatusViewers(statusId: string, authorId: string) {
  const owned = await one('SELECT 1 FROM statuses WHERE id = $1 AND author_id = $2', [statusId, authorId]);
  if (!owned) throw notFound('That status is not yours.');

  return many<{ userId: string; displayName: string; customAddress: string; avatarUrl: string | null; viewedAt: Date }>(
    `SELECT u.id AS "userId", u.display_name AS "displayName", u.custom_address AS "customAddress",
            u.avatar_key AS "avatarUrl", v.viewed_at AS "viewedAt"
       FROM status_views v
       JOIN users u ON u.id = v.viewer_id
      WHERE v.status_id = $1
      ORDER BY v.viewed_at DESC`,
    [statusId],
  );
}

export async function deleteStatus(statusId: string, authorId: string): Promise<void> {
  const row = await one<{ id: string }>(
    'UPDATE statuses SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING id',
    [statusId, authorId],
  );
  if (!row) throw notFound('That status is not yours, or is already gone.');
}

/**
 * Deletes expired statuses and their media for real, rather than leaving them hidden behind an
 * expiry check. A status that says it disappears after a day should actually be gone.
 */
export async function purgeExpiredStatuses(): Promise<number> {
  const media = await many<{ storage_key: string }>(
    `SELECT sm.storage_key
       FROM status_media sm
       JOIN statuses s ON s.id = sm.status_id
      WHERE s.expires_at <= now() OR s.deleted_at IS NOT NULL`,
  );
  // Orphans: an upload whose status was never created, left behind by an abandoned composer.
  const orphans = await many<{ storage_key: string }>(
    "SELECT storage_key FROM status_media WHERE status_id IS NULL AND created_at < now() - interval '6 hours'",
  );

  for (const row of [...media, ...orphans]) {
    await storage.remove(row.storage_key).catch(() => {
      /* a blob that is already gone is the desired state */
    });
  }

  await query("DELETE FROM status_media WHERE status_id IS NULL AND created_at < now() - interval '6 hours'");
  const deleted = await query(
    'DELETE FROM statuses WHERE expires_at <= now() OR deleted_at IS NOT NULL',
  );
  return deleted.rowCount ?? 0;
}

/** Resolves a status media id to its blob, for a viewer who holds a key for that status. */
export async function statusMediaForViewer(
  mediaId: string,
  viewerId: string,
): Promise<{ storageKey: string; byteSize: number }> {
  const row = await one<{ storage_key: string; byte_size: number; status_id: string | null; uploader_id: string }>(
    'SELECT storage_key, byte_size, status_id, uploader_id FROM status_media WHERE id = $1',
    [mediaId],
  );
  if (!row) throw notFound('That image is not available.');

  // Not yet attached: only the person who uploaded it can see it, so a composer can preview.
  if (!row.status_id) {
    if (row.uploader_id !== viewerId) throw notFound('That image is not available.');
    return { storageKey: row.storage_key, byteSize: row.byte_size };
  }

  const key = await one(
    `SELECT 1 FROM status_keys k
       JOIN statuses s ON s.id = k.status_id
      WHERE k.status_id = $1 AND k.user_id = $2 AND s.deleted_at IS NULL AND s.expires_at > now()`,
    [row.status_id, viewerId],
  );
  if (!key) throw forbidden('You do not have access to this image.');
  return { storageKey: row.storage_key, byteSize: row.byte_size };
}
