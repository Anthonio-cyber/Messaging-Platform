import { Router, raw } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { asyncRoute, parseQuery } from '../lib/http.js';
import { badRequest, forbidden, notFound, tooLarge } from '../lib/errors.js';
import { one, query } from '../db/pool.js';
import { ALLOWED_CATEGORIES, isBlockedFilename, scanUpload, storage } from '../lib/storage.js';
import { attachAuth, requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/rateLimit.js';
import { requireMembership } from '../services/conversation.service.js';
import { areContacts, blockState, getPrivacy } from '../services/user.service.js';

export const fileRouter: Router = Router();

const uuid = z.string().uuid();

/** Magic-byte check so an avatar cannot be an executable wearing an image extension. */
function detectImage(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF89a' || buffer.subarray(0, 6).toString('ascii') === 'GIF87a') {
    return 'image/gif';
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Uploads an encrypted attachment. The body is opaque ciphertext produced by the sender's
 * browser; the filename and the file key travel inside the encrypted message payload, so
 * nothing identifying is stored beside the bytes.
 */
fileRouter.post(
  '/attachments/:conversationId',
  requireAuth(),
  limiters.upload,
  raw({ type: '*/*', limit: env.MAX_UPLOAD_BYTES }),
  asyncRoute(async (req, res) => {
    const { conversationId } = parseQuery(z.object({ conversationId: uuid }), req.params);
    const { category, filename } = parseQuery(
      z.object({
        category: z.string().default('file'),
        filename: z.string().max(255).optional(),
      }),
      req.query,
    );

    if (!ALLOWED_CATEGORIES.has(category)) throw badRequest('That file category is not supported.');
    if (filename && isBlockedFilename(filename)) {
      throw badRequest('That file type cannot be shared here.');
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) throw badRequest('The upload was empty.');
    if (body.byteLength > env.MAX_UPLOAD_BYTES) {
      throw tooLarge(`Files must be ${Math.floor(env.MAX_UPLOAD_BYTES / (1024 * 1024))} MB or smaller.`);
    }

    await requireMembership(conversationId, req.auth!.user.id);

    const scan = await scanUpload(body);
    if (scan === 'rejected') throw badRequest('That file was rejected by our safety scan.');

    // Unguessable key; access is still checked on every download.
    const storageKey = `attachments/${conversationId}/${randomUUID()}.bin`;
    await storage.put(storageKey, body, 'application/octet-stream');

    const row = await one<{ id: string }>(
      `INSERT INTO attachments (uploader_id, conversation_id, storage_key, byte_size, mime_type, category, scan_status)
       VALUES ($1,$2,$3,$4,'application/octet-stream',$5,$6) RETURNING id`,
      [req.auth!.user.id, conversationId, storageKey, body.byteLength, category, scan],
    );

    res.status(201).json({
      attachment: { id: row!.id, byteSize: body.byteLength, category, scanStatus: scan },
    });
  }),
);

/** Streams an attachment back to a member of its conversation. */
fileRouter.get(
  '/attachments/:id',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const row = await one<{
      storage_key: string;
      conversation_id: string | null;
      byte_size: number;
      message_id: string | null;
    }>('SELECT storage_key, conversation_id, byte_size, message_id FROM attachments WHERE id = $1', [id]);
    if (!row || !row.conversation_id) throw notFound('That file is not available.');

    await requireMembership(row.conversation_id, req.auth!.user.id);

    // Once attached to a message, the message key gates the file the same way it gates the text.
    if (row.message_id) {
      const key = await one('SELECT 1 FROM message_keys WHERE message_id = $1 AND user_id = $2', [
        row.message_id,
        req.auth!.user.id,
      ]);
      if (!key) throw forbidden('You do not have access to this file.');
    }

    const signed = await storage.signedUrl(row.storage_key, 300);
    if (signed) {
      res.redirect(302, signed);
      return;
    }

    const stream = await storage.getStream(row.storage_key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(row.byte_size));
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }),
);

/** Avatars are not end-to-end encrypted — other people have to be able to see them. */
fileRouter.post(
  '/avatar',
  requireAuth(),
  limiters.upload,
  raw({ type: '*/*', limit: MAX_AVATAR_BYTES }),
  asyncRoute(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) throw badRequest('The upload was empty.');
    if (body.byteLength > MAX_AVATAR_BYTES) throw tooLarge('Profile pictures must be 2 MB or smaller.');

    const mime = detectImage(body);
    if (!mime) throw badRequest('Profile pictures must be a JPEG, PNG, GIF or WebP image.');

    const userId = req.auth!.user.id;
    const extension = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]!;
    const storageKey = `avatars/${userId}/${randomUUID()}.${extension}`;
    await storage.put(storageKey, body, mime);

    const previous = await one<{ avatar_key: string | null }>('SELECT avatar_key FROM users WHERE id = $1', [userId]);
    await query('UPDATE users SET avatar_key = $2, updated_at = now() WHERE id = $1', [userId, storageKey]);
    if (previous?.avatar_key) await storage.remove(previous.avatar_key).catch(() => {});

    res.status(201).json({ avatarUrl: `${env.API_URL}/api/files/${encodeURIComponent(storageKey)}` });
  }),
);

fileRouter.delete(
  '/avatar',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const userId = req.auth!.user.id;
    const previous = await one<{ avatar_key: string | null }>('SELECT avatar_key FROM users WHERE id = $1', [userId]);
    await query('UPDATE users SET avatar_key = NULL, updated_at = now() WHERE id = $1', [userId]);
    if (previous?.avatar_key) await storage.remove(previous.avatar_key).catch(() => {});
    res.json({ ok: true });
  }),
);

/**
 * Serves stored objects by key. Avatar visibility follows the owner's privacy setting;
 * attachment keys are refused here and must go through the id route, which checks membership.
 */
fileRouter.get(
  '/:key(*)',
  attachAuth(),
  asyncRoute(async (req, res) => {
    const key = decodeURIComponent(String(req.params.key ?? ''));
    if (!key.startsWith('avatars/')) throw notFound('That file is not available.');

    const ownerId = key.split('/')[1];
    if (!ownerId) throw notFound('That file is not available.');

    const owner = await one<{ id: string; avatar_key: string | null }>(
      'SELECT id, avatar_key FROM users WHERE id = $1 AND deleted_at IS NULL',
      [ownerId],
    );
    // Only the current avatar is servable: replaced keys stop resolving immediately.
    if (!owner || owner.avatar_key !== key) throw notFound('That file is not available.');

    const viewerId = req.auth?.user.id ?? null;
    if (viewerId !== ownerId) {
      const privacy = await getPrivacy(ownerId);
      const visible =
        privacy.avatar_visible === 'everyone'
          ? true
          : privacy.avatar_visible === 'contacts'
            ? viewerId !== null && (await areContacts(viewerId, ownerId))
            : false;
      if (!visible) throw notFound('That file is not available.');
      if (viewerId) {
        const blocks = await blockState(viewerId, ownerId);
        if (blocks.either) throw notFound('That file is not available.');
      }
    }

    const signed = await storage.signedUrl(key, 300);
    if (signed) {
      res.redirect(302, signed);
      return;
    }

    const stream = await storage.getStream(key);
    const extension = key.split('.').pop()?.toLowerCase() ?? '';
    const mimeByExtension: Record<string, string> = {
      jpg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    res.setHeader('Content-Type', mimeByExtension[extension] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }),
);
