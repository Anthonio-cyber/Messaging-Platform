import { Router, raw } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { badRequest, tooLarge } from '../lib/errors.js';
import { one } from '../db/pool.js';
import { storage } from '../lib/storage.js';
import { requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/rateLimit.js';
import {
  createStatus,
  deleteStatus,
  listStatusViewers,
  listStatuses,
  recordStatusView,
  statusAudience,
  statusMediaForViewer,
} from '../services/status.service.js';

export const statusRouter: Router = Router();

const uuid = z.string().uuid();

/** A status image is a photo, not a film: smaller than a chat attachment on purpose. */
const MAX_STATUS_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * The accounts this device must wrap a key for before posting.
 *
 * Returned as a separate call rather than inferred client-side: the audience depends on the
 * contact list, the block list and the author's own privacy setting, all of which live here.
 * The device needs each public key anyway in order to seal for them.
 */
statusRouter.get(
  '/audience',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const audience = await statusAudience(req.auth!.user.id);
    res.json({
      audience,
      // Said plainly so the composer can be honest about reach before anything is posted.
      reach: audience.length,
    });
  }),
);

statusRouter.get(
  '/',
  requireAuth(),
  asyncRoute(async (req, res) => {
    res.json({ statuses: await listStatuses(req.auth!.user.id) });
  }),
);

statusRouter.post(
  '/',
  requireAuth(),
  limiters.postStatus,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        kind: z.enum(['text', 'image']).default('text'),
        ciphertext: z.string().min(1),
        nonce: z.string().min(1),
        keys: z
          .array(z.object({ userId: uuid, wrappedKey: z.string().min(1) }))
          .min(1)
          .max(2000),
        mediaId: uuid.nullish(),
      }),
      req.body,
    );

    const status = await createStatus({
      authorId: req.auth!.user.id,
      kind: body.kind,
      ciphertext: body.ciphertext,
      nonce: body.nonce,
      keys: body.keys,
      mediaId: body.mediaId ?? null,
    });
    res.status(201).json({ status });
  }),
);

/**
 * Uploads a status image. The body is ciphertext produced by the poster's browser, exactly as
 * with chat attachments — the file key travels inside the encrypted status payload, so this
 * server holds bytes it cannot read and no filename to go with them.
 */
statusRouter.post(
  '/media',
  requireAuth(),
  limiters.upload,
  raw({ type: '*/*', limit: MAX_STATUS_IMAGE_BYTES }),
  asyncRoute(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) throw badRequest('The upload was empty.');
    if (body.byteLength > MAX_STATUS_IMAGE_BYTES) {
      throw tooLarge(`Status images must be ${MAX_STATUS_IMAGE_BYTES / (1024 * 1024)} MB or smaller.`);
    }

    const storageKey = `statuses/${req.auth!.user.id}/${randomUUID()}.bin`;
    await storage.put(storageKey, body, 'application/octet-stream');

    const row = await one<{ id: string }>(
      `INSERT INTO status_media (uploader_id, storage_key, byte_size) VALUES ($1,$2,$3) RETURNING id`,
      [req.auth!.user.id, storageKey, body.byteLength],
    );
    res.status(201).json({ mediaId: row!.id });
  }),
);

statusRouter.get(
  '/media/:id',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const media = await statusMediaForViewer(id, req.auth!.user.id);

    const signed = await storage.signedUrl(media.storageKey, 300);
    if (signed) {
      res.redirect(302, signed);
      return;
    }

    const stream = await storage.getStream(media.storageKey);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(media.byteSize));
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }),
);

statusRouter.post(
  '/:id/view',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    await recordStatusView(id, req.auth!.user.id);
    res.json({ ok: true });
  }),
);

statusRouter.get(
  '/:id/viewers',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const viewers = await listStatusViewers(id, req.auth!.user.id);
    res.json({
      viewers: viewers.map((viewer) => ({
        ...viewer,
        avatarUrl: viewer.avatarUrl
          ? `${env.API_URL}/api/files/${encodeURIComponent(viewer.avatarUrl)}`
          : null,
        viewedAt: new Date(viewer.viewedAt).toISOString(),
      })),
    });
  }),
);

statusRouter.delete(
  '/:id',
  requireAuth(),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    // Marked deleted here, so it stops being served at once; the blob and row go on the next
    // sweep, which is also what removes it for anyone mid-view.
    await deleteStatus(id, req.auth!.user.id);
    res.json({ ok: true });
  }),
);
