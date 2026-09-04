import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { attachAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { limiters } from './middleware/rateLimit.js';
import { corsPolicy, csrfProtection, ensureCsrfCookie, securityHeaders } from './middleware/security.js';
import { authRouter } from './routes/auth.routes.js';
import { userRouter } from './routes/user.routes.js';
import { conversationRouter } from './routes/conversation.routes.js';
import { messageRouter } from './routes/message.routes.js';
import { requestRouter } from './routes/request.routes.js';
import { safetyRouter } from './routes/safety.routes.js';
import { notificationRouter } from './routes/notification.routes.js';
import { fileRouter } from './routes/file.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { pool } from './db/pool.js';

export function createApp(): Express {
  const app = express();

  // Only honour X-Forwarded-* when the deployment actually sits behind a proxy.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(securityHeaders());
  app.use(corsPolicy());
  app.use(compression());
  app.use(cookieParser());

  // File routes read raw bodies; the JSON parser must not consume them first.
  app.use('/api/files', fileRouter);

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(ensureCsrfCookie());
  app.use(attachAuth());

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });

  app.get('/api/config', (_req, res) => {
    // Public, non-secret configuration the browser needs to render itself.
    res.json({
      brandName: env.BRAND_NAME,
      identityDomain: env.IDENTITY_DOMAIN,
      appUrl: env.APP_URL,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      realtimePath: '/realtime',
    });
  });

  app.use('/api', limiters.api);
  app.use('/api', csrfProtection());

  app.use('/api/auth', authRouter);
  app.use('/api/users', userRouter);
  app.use('/api/conversations', conversationRouter);
  app.use('/api/chat', messageRouter);
  app.use('/api/requests', requestRouter);
  app.use('/api/safety', safetyRouter);
  app.use('/api/notifications', notificationRouter);
  app.use('/api/admin', adminRouter);

  serveWebApp(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Serves the built web app when it is bundled alongside the API (the Docker image does
 * this). Deployments that host the frontend separately — a CDN, or Vite in development —
 * simply have no build here, and this is a no-op.
 */
function serveWebApp(app: Express): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../web/dist'),
    path.resolve(process.cwd(), 'web/dist'),
  ];
  const webRoot = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
  if (!webRoot) return;

  // Fingerprinted assets are immutable; index.html must never be cached or clients get
  // stranded on an old bundle after a deploy.
  app.use(
    express.static(webRoot, {
      index: false,
      maxAge: '1y',
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
      },
    }),
  );

  // Client-side routing: any non-API path falls through to the app shell.
  app.get(/^(?!\/api\/|\/realtime).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(webRoot, 'index.html'));
  });

  console.log(`[veylo] serving the web app from ${webRoot}`);
}
