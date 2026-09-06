import type { NextFunction, Request, Response } from 'express';
import { clientIp } from '../lib/http.js';
import { rateLimited } from '../lib/errors.js';
import { env } from '../config/env.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter held in process memory.
 *
 * This is correct for a single instance. Running several API instances multiplies the
 * effective limit by the instance count, so a shared store (Redis) should back this in a
 * horizontally scaled deployment — see docs/DEPLOYMENT.md. The security-critical limits
 * (sign-in, registration, password reset) are additionally enforced against the
 * login_attempts table, which is shared by every instance.
 */
const buckets = new Map<string, Bucket>();

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweep.unref();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to the client IP. Use to bucket per account or per conversation. */
  key?: (req: Request) => string;
  message?: string;
}

export function rateLimit(name: string, options: RateLimitOptions) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ip = clientIp(req);
    if (env.trustedIps.includes(ip)) return next();

    const identity = options.key ? options.key(req) : ip;
    const key = `${name}:${identity}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    existing.count += 1;
    if (existing.count > options.max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      _res.setHeader('Retry-After', String(retryAfter));
      return next(rateLimited(options.message ?? 'Too many requests. Try again shortly.', retryAfter));
    }
    next();
  };
}

/** Test helper: forget all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}

export const limiters = {
  // Sign-in and registration are the highest-value targets, so they are the tightest.
  signIn: rateLimit('signin', { windowMs: 15 * 60_000, max: 10, message: 'Too many sign-in attempts. Wait a few minutes and try again.' }),
  register: rateLimit('register', { windowMs: 60 * 60_000, max: 5, message: 'Too many accounts created from this network. Try again later.' }),
  passwordReset: rateLimit('reset', { windowMs: 60 * 60_000, max: 5, message: 'Too many password reset requests. Try again later.' }),
  saltLookup: rateLimit('salt', { windowMs: 15 * 60_000, max: 60 }),
  search: rateLimit('search', { windowMs: 60_000, max: 60 }),
  upload: rateLimit('upload', { windowMs: 60_000, max: 30, message: 'Too many uploads. Give it a moment.' }),
  sendMessage: rateLimit('send', { windowMs: 60_000, max: 120, message: 'You are sending messages very quickly. Slow down a little.' }),
  messageRequest: rateLimit('request', { windowMs: 60 * 60_000, max: 20, message: 'You have sent a lot of message requests recently. Try again later.' }),
  report: rateLimit('report', { windowMs: 60 * 60_000, max: 15 }),
  api: rateLimit('api', { windowMs: 60_000, max: 600 }),
};
