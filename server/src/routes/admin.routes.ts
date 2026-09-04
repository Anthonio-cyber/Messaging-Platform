import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, parseBody, parseQuery } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { many, one, query } from '../db/pool.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { applyAccountAction, recordAdminAction } from '../services/moderation.service.js';
import { recordSecurityEvent } from '../services/security.service.js';
import { avatarUrl } from '../services/user.service.js';
import { purgeExpiredSessions } from '../services/session.service.js';
import { disconnectUserSockets } from '../realtime/emitter.js';

export const adminRouter: Router = Router();

// Every route here is staff-only. Moderators get the queue; admins get the rest.
adminRouter.use(requireAuth(), requireRole('moderator'));

const uuid = z.string().uuid();

adminRouter.get(
  '/overview',
  asyncRoute(async (_req, res) => {
    const stats = await one<{
      total_users: number;
      active_users: number;
      suspended_users: number;
      banned_users: number;
      new_today: number;
      new_week: number;
      online_now: number;
      total_messages: number;
      messages_today: number;
      total_conversations: number;
      group_conversations: number;
      open_reports: number;
      pending_requests: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS total_users,
         (SELECT count(*)::int FROM users WHERE status = 'active' AND deleted_at IS NULL) AS active_users,
         (SELECT count(*)::int FROM users WHERE status = 'suspended') AS suspended_users,
         (SELECT count(*)::int FROM users WHERE status = 'banned') AS banned_users,
         (SELECT count(*)::int FROM users WHERE created_at > now() - interval '1 day') AS new_today,
         (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS new_week,
         (SELECT count(*)::int FROM users WHERE presence <> 'offline' AND last_seen_at > now() - interval '5 minutes') AS online_now,
         (SELECT count(*)::int FROM messages) AS total_messages,
         (SELECT count(*)::int FROM messages WHERE created_at > now() - interval '1 day') AS messages_today,
         (SELECT count(*)::int FROM conversations WHERE deleted_at IS NULL) AS total_conversations,
         (SELECT count(*)::int FROM conversations WHERE type = 'group' AND deleted_at IS NULL) AS group_conversations,
         (SELECT count(*)::int FROM reports WHERE status IN ('open','reviewing')) AS open_reports,
         (SELECT count(*)::int FROM message_requests WHERE status = 'pending') AS pending_requests`,
    );

    const security = await one<{ failed_logins_24h: number; critical_events_24h: number; active_sessions: number }>(
      `SELECT
         (SELECT count(*)::int FROM login_attempts WHERE successful = FALSE AND created_at > now() - interval '1 day') AS failed_logins_24h,
         (SELECT count(*)::int FROM security_events WHERE severity = 'critical' AND created_at > now() - interval '1 day') AS critical_events_24h,
         (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_sessions`,
    );

    const signupTrend = await many<{ day: string; count: number }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*)::int FROM users u
                WHERE u.created_at >= d.day AND u.created_at < d.day + interval '1 day') AS count
         FROM generate_series(current_date - interval '13 days', current_date, interval '1 day') AS d(day)
        ORDER BY d.day`,
    );

    res.json({
      stats,
      security,
      signupTrend,
      server: {
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

adminRouter.get(
  '/users',
  asyncRoute(async (req, res) => {
    const { q, status, limit, offset } = parseQuery(
      z.object({
        q: z.string().trim().max(120).optional(),
        status: z.enum(['active', 'suspended', 'banned', 'deleted', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );

    const pattern = q ? `%${q.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
    const rows = await many<{
      id: string;
      username: string;
      custom_address: string;
      display_name: string;
      avatar_key: string | null;
      role: string;
      status: string;
      suspended_until: Date | null;
      moderation_note: string | null;
      created_at: Date;
      last_seen_at: Date | null;
      open_reports: number;
      total: number;
    }>(
      `SELECT u.id, u.username, u.custom_address, u.display_name, u.avatar_key, u.role, u.status::text AS status,
              u.suspended_until, u.moderation_note, u.created_at, u.last_seen_at,
              (SELECT count(*)::int FROM reports r WHERE r.reported_user_id = u.id AND r.status IN ('open','reviewing')) AS open_reports,
              count(*) OVER()::int AS total
         FROM users u
        WHERE ($1::text IS NULL OR u.username LIKE $1 ESCAPE '\\' OR u.custom_address LIKE $1 ESCAPE '\\'
               OR lower(u.display_name) LIKE $1 ESCAPE '\\')
          AND ($2 = 'all' OR u.status::text = $2)
        ORDER BY u.created_at DESC
        LIMIT $3 OFFSET $4`,
      [pattern, status, limit, offset],
    );

    res.json({
      total: rows[0]?.total ?? 0,
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        customAddress: r.custom_address,
        displayName: r.display_name,
        avatarUrl: avatarUrl(r.avatar_key),
        role: r.role,
        status: r.status,
        suspendedUntil: r.suspended_until ? new Date(r.suspended_until).toISOString() : null,
        moderationNote: r.moderation_note,
        createdAt: new Date(r.created_at).toISOString(),
        lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
        openReports: Number(r.open_reports),
      })),
    });
  }),
);

adminRouter.get(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const user = await one<Record<string, unknown>>(
      `SELECT id, username, custom_address, display_name, avatar_key, bio, role, status::text AS status,
              suspended_until, moderation_note, created_at, last_seen_at, failed_login_count, locked_until,
              recovery_email_verified
         FROM users WHERE id = $1`,
      [id],
    );
    if (!user) throw notFound('That account does not exist.');

    const activity = await one<{ conversations: number; messages_sent: number; reports_against: number; reports_filed: number }>(
      `SELECT
         (SELECT count(*)::int FROM conversation_members WHERE user_id = $1 AND left_at IS NULL) AS conversations,
         (SELECT count(*)::int FROM messages WHERE sender_id = $1) AS messages_sent,
         (SELECT count(*)::int FROM reports WHERE reported_user_id = $1) AS reports_against,
         (SELECT count(*)::int FROM reports WHERE reporter_id = $1) AS reports_filed`,
      [id],
    );

    const sessions = await many(
      `SELECT id, device_label, created_at, last_active_at, expires_at
         FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_active_at DESC LIMIT 20`,
      [id],
    );

    const events = await many(
      `SELECT id, event_type, severity, created_at, metadata FROM security_events
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [id],
    );

    // Message content is end-to-end encrypted and is never surfaced here.
    res.json({ user, activity, sessions, events });
  }),
);

adminRouter.post(
  '/users/:id/actions',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const body = parseBody(
      z.object({
        action: z.enum(['suspend', 'ban', 'restore']),
        days: z.number().int().min(1).max(3650).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    if (id === req.auth!.user.id) throw badRequest('You cannot moderate your own account.');

    await applyAccountAction(req.auth!.user.id, id, body.action, { days: body.days, note: body.note });
    await recordSecurityEvent(id, `admin.${body.action}`, req, { by: req.auth!.user.id }, 'critical');
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/users/:id/sessions/revoke',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const result = await query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [id],
    );
    await disconnectUserSockets(id);
    await recordAdminAction({
      adminId: req.auth!.user.id,
      action: 'sessions.revoke_all',
      targetType: 'user',
      targetId: id,
    });
    res.json({ revoked: result.rowCount ?? 0 });
  }),
);

adminRouter.patch(
  '/users/:id/role',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const { role } = parseBody(z.object({ role: z.enum(['user', 'moderator', 'admin']) }), req.body);
    if (id === req.auth!.user.id) throw badRequest('You cannot change your own role.');

    await query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [id, role]);
    await recordAdminAction({
      adminId: req.auth!.user.id,
      action: 'role.change',
      targetType: 'user',
      targetId: id,
      metadata: { role },
    });
    await recordSecurityEvent(id, 'admin.role_changed', req, { role, by: req.auth!.user.id }, 'critical');
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/reports',
  asyncRoute(async (req, res) => {
    const { status, limit, offset } = parseQuery(
      z.object({
        status: z.enum(['open', 'reviewing', 'resolved', 'dismissed', 'all']).default('open'),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );

    const rows = await many<Record<string, unknown>>(
      `SELECT r.id, r.target_type::text AS target_type, r.category, r.reason, r.evidence,
              r.status::text AS status, r.created_at, r.resolved_at, r.resolution_note,
              reporter.username AS reporter_username, reporter.id AS reporter_id,
              reported.username AS reported_username, reported.id AS reported_id,
              reported.status::text AS reported_status,
              r.message_id, r.conversation_id,
              count(*) OVER()::int AS total
         FROM reports r
         LEFT JOIN users reporter ON reporter.id = r.reporter_id
         LEFT JOIN users reported ON reported.id = r.reported_user_id
        WHERE ($1 = 'all' OR r.status::text = $1)
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );

    res.json({ total: (rows[0]?.total as number) ?? 0, reports: rows });
  }),
);

adminRouter.patch(
  '/reports/:id',
  asyncRoute(async (req, res) => {
    const { id } = parseQuery(z.object({ id: uuid }), req.params);
    const body = parseBody(
      z.object({
        status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']),
        note: z.string().trim().max(2000).optional(),
      }),
      req.body,
    );

    const result = await query(
      `UPDATE reports
          SET status = $2::report_status, resolution_note = COALESCE($3, resolution_note), handled_by = $4,
              resolved_at = CASE WHEN $2::text IN ('resolved','dismissed') THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, body.status, body.note ?? null, req.auth!.user.id],
    );
    if ((result.rowCount ?? 0) === 0) throw notFound('That report does not exist.');

    await recordAdminAction({
      adminId: req.auth!.user.id,
      action: `report.${body.status}`,
      targetType: 'report',
      targetId: id,
      note: body.note,
    });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/security',
  asyncRoute(async (req, res) => {
    const { limit } = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );

    const events = await many(
      `SELECT e.id, e.event_type, e.severity, e.created_at, e.metadata, e.user_agent,
              u.username, u.id AS user_id
         FROM security_events e LEFT JOIN users u ON u.id = e.user_id
        ORDER BY e.created_at DESC LIMIT $1`,
      [limit],
    );

    const failedLogins = await many(
      `SELECT date_trunc('hour', created_at) AS hour, count(*)::int AS count
         FROM login_attempts
        WHERE successful = FALSE AND created_at > now() - interval '24 hours'
        GROUP BY 1 ORDER BY 1`,
    );

    const suspicious = await many(
      `SELECT identifier_hash, count(*)::int AS attempts, max(created_at) AS last_attempt
         FROM login_attempts
        WHERE successful = FALSE AND created_at > now() - interval '24 hours'
        GROUP BY identifier_hash HAVING count(*) >= 5
        ORDER BY attempts DESC LIMIT 25`,
    );

    const sessions = await one<{ active: number; distinct_users: number }>(
      `SELECT count(*)::int AS active, count(DISTINCT user_id)::int AS distinct_users
         FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`,
    );

    res.json({ events, failedLogins, suspicious, sessions });
  }),
);

adminRouter.get(
  '/audit',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const { limit } = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
    );
    const actions = await many(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.note, a.metadata, a.created_at,
              u.username AS admin_username
         FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
        ORDER BY a.created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ actions });
  }),
);

adminRouter.post(
  '/maintenance/purge-sessions',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const removed = await purgeExpiredSessions();
    await recordAdminAction({
      adminId: req.auth!.user.id,
      action: 'maintenance.purge_sessions',
      targetType: 'system',
      targetId: 'sessions',
      metadata: { removed },
    });
    res.json({ removed });
  }),
);
