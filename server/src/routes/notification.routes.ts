import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { countUnread, listNotifications, markRead } from '../services/notification.service.js';
import { countIncoming } from '../services/request.service.js';
import {
  countSubscriptions,
  pushEnabled,
  removeSubscription,
  saveSubscription,
} from '../services/push.service.js';

export const notificationRouter: Router = Router();
notificationRouter.use(requireAuth());

notificationRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { limit, unreadOnly } = parseQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(40),
        unreadOnly: z.enum(['true', 'false']).default('false'),
      }),
      req.query,
    );
    res.json({
      notifications: await listNotifications(req.auth!.user.id, limit, unreadOnly === 'true'),
      unreadCount: await countUnread(req.auth!.user.id),
    });
  }),
);

/** Badge counts for the sidebar in one round trip. */
notificationRouter.get(
  '/summary',
  asyncRoute(async (req, res) => {
    res.json({
      unreadNotifications: await countUnread(req.auth!.user.id),
      pendingRequests: await countIncoming(req.auth!.user.id),
    });
  }),
);

notificationRouter.post(
  '/read',
  asyncRoute(async (req, res) => {
    const { ids } = parseBody(
      z.object({ ids: z.array(z.string().uuid()).max(200).nullish() }),
      req.body,
    );
    const updated = await markRead(req.auth!.user.id, ids ?? null);
    res.json({ updated, unreadCount: await countUnread(req.auth!.user.id) });
  }),
);

/**
 * The deployment's VAPID public key, so a browser can subscribe to push.
 *
 * Public by design — it is the key a push service uses to verify that a notification really
 * came from this deployment, and the browser needs it to create the subscription at all.
 * Served behind auth anyway, since only signed-in devices have any use for it.
 */
notificationRouter.get(
  '/push/key',
  asyncRoute(async (req, res) => {
    res.json({
      enabled: pushEnabled(),
      publicKey: env.VAPID_PUBLIC_KEY ?? null,
      devices: await countSubscriptions(req.auth!.user.id),
    });
  }),
);

notificationRouter.post(
  '/push/subscribe',
  asyncRoute(async (req, res) => {
    if (!pushEnabled()) throw badRequest('Push notifications are not configured on this deployment.');

    const body = parseBody(
      z.object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
      }),
      req.body,
    );

    await saveSubscription(req.auth!.user.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      // Only to let someone recognise their own devices in settings.
      userAgent: String(req.get('user-agent') ?? ''),
    });
    res.status(201).json({ ok: true, devices: await countSubscriptions(req.auth!.user.id) });
  }),
);

notificationRouter.post(
  '/push/unsubscribe',
  asyncRoute(async (req, res) => {
    const { endpoint } = parseBody(z.object({ endpoint: z.string().url().max(2000) }), req.body);
    await removeSubscription(req.auth!.user.id, endpoint);
    res.json({ ok: true, devices: await countSubscriptions(req.auth!.user.id) });
  }),
);
