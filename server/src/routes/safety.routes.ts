import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/rateLimit.js';
import {
  REPORT_CATEGORIES,
  blockUser,
  createReport,
  listBlocked,
  unblockUser,
} from '../services/moderation.service.js';
import { recordSecurityEvent } from '../services/security.service.js';

export const safetyRouter: Router = Router();
safetyRouter.use(requireAuth());

const uuid = z.string().uuid();

safetyRouter.get(
  '/blocks',
  asyncRoute(async (req, res) => {
    res.json({ blocked: await listBlocked(req.auth!.user.id) });
  }),
);

safetyRouter.post(
  '/blocks',
  asyncRoute(async (req, res) => {
    const { userId } = parseBody(z.object({ userId: uuid }), req.body);
    await blockUser(req.auth!.user.id, userId);
    await recordSecurityEvent(req.auth!.user.id, 'moderation.block', req, { targetId: userId });
    res.json({ ok: true });
  }),
);

safetyRouter.delete(
  '/blocks/:userId',
  asyncRoute(async (req, res) => {
    const { userId } = parseQuery(z.object({ userId: uuid }), req.params);
    await unblockUser(req.auth!.user.id, userId);
    res.json({ ok: true });
  }),
);

/**
 * Files an abuse report. Because messages are end-to-end encrypted, a reported excerpt is
 * only ever included when the reporter chooses to attach it from their own device.
 */
safetyRouter.post(
  '/reports',
  limiters.report,
  asyncRoute(async (req, res) => {
    const body = parseBody(
      z.object({
        targetType: z.enum(['user', 'message', 'conversation']),
        reportedUserId: uuid.nullish(),
        messageId: uuid.nullish(),
        conversationId: uuid.nullish(),
        category: z.enum(REPORT_CATEGORIES),
        reason: z.string().trim().max(2000).default(''),
        includeExcerpt: z.boolean().default(false),
        excerpt: z.string().max(4000).optional(),
      }),
      req.body,
    );

    const result = await createReport({
      reporterId: req.auth!.user.id,
      targetType: body.targetType,
      reportedUserId: body.reportedUserId ?? null,
      messageId: body.messageId ?? null,
      conversationId: body.conversationId ?? null,
      category: body.category,
      reason: body.reason,
      evidence: body.includeExcerpt && body.excerpt
        ? { excerpt: body.excerpt, capturedAt: new Date().toISOString() }
        : null,
    });

    res.status(201).json({
      report: result,
      message: 'Thanks — our moderation team will review this.',
    });
  }),
);

safetyRouter.get('/reports/categories', (_req, res) => {
  res.json({ categories: REPORT_CATEGORIES });
});
