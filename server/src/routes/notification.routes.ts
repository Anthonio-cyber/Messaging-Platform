import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { countUnread, listNotifications, markRead } from '../services/notification.service.js';
import { countIncoming } from '../services/request.service.js';

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
