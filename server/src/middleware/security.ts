import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from '../config/env.js';
import { forbidden } from '../lib/errors.js';
import { constantTimeEquals, generateToken } from '../lib/crypto.js';

export const CSRF_COOKIE = 'veylo_csrf';
export const CSRF_HEADER = 'x-veylo-csrf';

export function securityHeaders(): RequestHandler {
  return helmet({
    /*
     * One policy covers both deployment shapes: the API alone (where nothing but JSON and
     * attachment bytes is served) and the single image that also serves the built web app.
     *
     * - 'self' for scripts and styles: the bundle is same-origin and fingerprinted.
     * - 'wasm-unsafe-eval' for scripts: libsodium compiles a WebAssembly module, which CSP
     *   blocks under a bare 'self'. This directive permits WebAssembly compilation ONLY —
     *   it does not re-enable eval() or inline script, which 'unsafe-eval' would.
     * - blob: for images and media so decrypted attachments can be displayed after the
     *   browser decrypts them into an object URL.
     * - connect-src includes ws:/wss: for the realtime socket.
     * - No 'unsafe-inline' for scripts. React applies inline styles through the CSSOM,
     *   which CSP does not gate, so style-src stays strict too.
     */
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        ...(env.isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    // Attachment downloads must not be sniffed into executable types.
    noSniff: true,
    frameguard: { action: 'deny' },
  });
}

export function corsPolicy(): RequestHandler {
  return cors({
    origin(origin, callback) {
      // Same-origin and non-browser clients send no Origin header.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} is not allowed.`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection.
 *
 * Session cookies are SameSite=Lax, which already blocks cross-site POSTs from forms, but
 * the token check also covers requests that carry the cookie via a permitted CORS origin.
 * Requests authenticated purely by an Authorization header carry no ambient credentials
 * and are therefore exempt.
 */
export function csrfProtection(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.headers.authorization?.startsWith('Bearer ')) return next();

    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.headers[CSRF_HEADER];
    const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !provided || !constantTimeEquals(String(cookieToken), String(provided))) {
      return next(forbidden('Your session could not be verified. Refresh the page and try again.'));
    }
    next();
  };
}

/** Issues the CSRF cookie (readable by the app's JS, unlike the session cookie). */
export function issueCsrfCookie(res: Response): string {
  const token = generateToken(24);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 3600 * 1000,
  });
  return token;
}

export function ensureCsrfCookie(): RequestHandler {
  return (req, res, next) => {
    if (!req.cookies?.[CSRF_COOKIE]) issueCsrfCookie(res);
    next();
  };
}
