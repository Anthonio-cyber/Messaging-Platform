/**
 * Vercel serverless entry.
 *
 * Vercel cannot hold a WebSocket open, so this deployment runs the Express app only — no
 * Socket.IO. The browser detects that and falls back to polling /api/sync (see
 * web/src/lib/realtime.ts). Every other deployment shape — the Docker image, a VPS, any
 * persistent host — keeps the WebSocket and true push.
 *
 * The app is built by `npm run build` before Vercel packages this function.
 */
import { createApp } from '../server/dist/app.js';

const app = createApp();

export default function handler(request, response) {
  // Vercel rewrites /api/* to this function; the original path arrives on x-vercel-original-path
  // on some runtimes and on req.url on others. Prefer whichever actually carries /api/.
  const original = request.headers['x-vercel-original-path'];
  if (typeof original === 'string' && original.startsWith('/api/')) {
    request.url = original;
  }
  return app(request, response);
}
