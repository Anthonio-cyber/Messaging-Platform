import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'bad_request',
        message: 'Some of the information you sent is not valid.',
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('is not allowed.') && message.startsWith('Origin ')) {
    res.status(403).json({ error: { code: 'forbidden', message: 'Request origin is not allowed.' } });
    return;
  }

  // Postgres unique violation that slipped past an explicit check.
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
    res.status(409).json({ error: { code: 'conflict', message: 'That value is already taken.' } });
    return;
  }

  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({
    error: {
      code: 'server_error',
      message: 'Something went wrong on our side. Please try again.',
      // Stack traces are never returned to clients in production.
      ...(env.isProduction ? {} : { debug: message }),
    },
  });
};
