import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncRoute, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { iceServers, listCallHistory } from '../services/call.service.js';

export const callRouter: Router = Router();
callRouter.use(requireAuth());

/**
 * ICE configuration for the browser's RTCPeerConnection.
 *
 * Served per request rather than baked into the bundle so TURN credentials can be rotated
 * without a redeploy, and so they are only handed to signed-in accounts.
 */
callRouter.get(
  '/ice',
  asyncRoute(async (_req, res) => {
    const config = iceServers();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      iceServers: config.iceServers,
      // The client shows an honest warning when there is no relay: without TURN, calls
      // between two restrictive networks will fail to connect.
      hasRelay: config.hasRelay,
      callsEnabled: env.CALLS_ENABLED,
    });
  }),
);

callRouter.get(
  '/history',
  asyncRoute(async (req, res) => {
    const { limit } = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    res.json({ calls: await listCallHistory(req.auth!.user.id, limit) });
  }),
);
