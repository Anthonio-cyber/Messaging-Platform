import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors.js';
import { env } from '../config/env.js';
import { blindIndex } from './crypto.js';

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'Some of the information you sent is not valid.',
      result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return result.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, queryValue: unknown): z.infer<S> {
  const result = schema.safeParse(queryValue);
  if (!result.success) {
    throw badRequest(
      'Invalid query parameters.',
      result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return result.data;
}

/** Client IP, honouring X-Forwarded-For only when the deployment says to trust the proxy. */
export function clientIp(req: Request): string {
  if (env.TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first?.trim()) return first.trim();
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}

/** IPs are only ever persisted as keyed hashes, never in the clear. */
export function clientIpHash(req: Request): string {
  return blindIndex(clientIp(req));
}

export function userAgent(req: Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 400) : 'unknown';
}

/** Derives a friendly device label from the user agent for the sessions list. */
export function deviceLabel(ua: string): string {
  const platform =
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown platform';
  const browser =
    /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser} on ${platform}`;
}
