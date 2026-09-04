import { createServer } from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { createRealtimeServer, shutdownRealtime } from './realtime/socket.js';
import { closePool, pool, query } from './db/pool.js';
import { purgeExpiredSessions } from './services/session.service.js';

async function main(): Promise<void> {
  // Refuse to serve traffic against a database we cannot reach.
  await pool.query('SELECT 1');

  const migrated = await query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'schema_migrations'",
  );
  if ((migrated.rows[0] as { count: number } | undefined)?.count === 0) {
    throw new Error('The database has no schema. Run: npm run migrate');
  }

  const app = createApp();
  const httpServer = createServer(app);
  const io = createRealtimeServer(httpServer);

  // Housekeeping: drop long-expired sessions once an hour.
  const cleanup = setInterval(
    () => {
      purgeExpiredSessions().catch((error) => console.error('[cleanup] session purge failed', error));
    },
    60 * 60 * 1000,
  );
  cleanup.unref();

  httpServer.listen(env.PORT, env.HOST, () => {
    console.log(`[veylo] ${env.BRAND_NAME} API listening on http://${env.HOST}:${env.PORT}`);
    console.log(`[veylo] identities are minted at @${env.IDENTITY_DOMAIN}`);
    console.log(`[veylo] app origin: ${env.APP_URL}`);
    if (!env.isProduction) console.log('[veylo] running in development mode');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[veylo] ${signal} received, shutting down`);
    clearInterval(cleanup);

    const force = setTimeout(() => {
      console.error('[veylo] forced exit after 10s');
      process.exit(1);
    }, 10_000);
    force.unref();

    await shutdownRealtime(io).catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('[veylo] unhandled rejection', reason));
}

main().catch((error) => {
  console.error('[veylo] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
