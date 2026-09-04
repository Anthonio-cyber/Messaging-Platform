import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import { SESSION_COOKIE, resolveSession, touchSession } from '../services/session.service.js';
import type { UserRole } from '../types.js';

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  const cookie = req.cookies?.[SESSION_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
}

/** Attaches req.auth when a valid session is present; never rejects. */
export function attachAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (!token) return next();
    resolveSession(token)
      .then((auth) => {
        if (auth) {
          req.auth = auth;
          void touchSession(auth.sessionId);
        }
        next();
      })
      .catch(next);
  };
}

/** Requires a signed-in, non-suspended account. */
export function requireAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.user.status === 'suspended') {
      return next(
        forbidden('This account is suspended. Contact support if you think this is a mistake.'),
      );
    }
    next();
  };
}

const RANK: Record<UserRole, number> = { user: 0, moderator: 1, admin: 2 };

/** Role-based access control for the moderation and admin surfaces. */
export function requireRole(minimum: UserRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorized());
    if (RANK[req.auth.user.role] < RANK[minimum]) {
      // Deliberately identical to any other 404-ish denial: staff routes are not advertised.
      return next(forbidden('You do not have access to this area.'));
    }
    next();
  };
}

export function currentUser(req: Request) {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}
