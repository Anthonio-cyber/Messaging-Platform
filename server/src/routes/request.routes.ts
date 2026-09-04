import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import {
  countIncoming,
  listRequests,
  respondToRequest,
  withdrawRequest,
} from '../services/request.service.js';
import { recordSecurityEvent } from '../services/security.service.js';
import { emitToUser } from '../realtime/emitter.js';

export const requestRouter: Router = Router();
requestRouter.use(requireAuth());

requestRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { direction } = parseQuery(
      z.object({ direction: z.enum(['incoming', 'outgoing', 'both']).default('incoming') }),
      req.query,
    );
    const userId = req.auth!.user.id;
    const [incoming, outgoing] =
      direction === 'both'
        ? await Promise.all([listRequests(userId, 'incoming'), listRequests(userId, 'outgoing')])
        : direction === 'incoming'
          ? [await listRequests(userId, 'incoming'), []]
          : [[], await listRequests(userId, 'outgoing')];

    res.json({ incoming, outgoing, incomingCount: incoming.length });
  }),
);

requestRouter.get(
  '/count',
  asyncRoute(async (req, res) => {
    res.json({ count: await countIncoming(req.auth!.user.id) });
  }),
);

requestRouter.post(
  '/:id/respond',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: z.string().uuid() }), req.params);
    const { decision } = parseBody(
      z.object({ decision: z.enum(['accepted', 'declined', 'blocked']) }),
      req.body,
    );

    const result = await respondToRequest(id, req.auth!.user.id, decision);
    if (decision === 'blocked') {
      await recordSecurityEvent(req.auth!.user.id, 'moderation.block_from_request', req, {
        targetId: result.senderId,
      });
    }
    emitToUser(req.auth!.user.id, 'request:resolved', { requestId: id, decision });
    res.json({ ok: true, decision, conversationId: result.conversationId });
  }),
);

requestRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: z.string().uuid() }), req.params);
    await withdrawRequest(id, req.auth!.user.id);
    res.json({ ok: true });
  }),
);
