/**
 * Deploy-time migration runner.
 *
 * Hosts that build from source (Vercel, Render, Fly) run this after the build so the schema is
 * current before the new version serves traffic. A project that has not had its database
 * configured yet still builds — it says so and exits cleanly, rather than failing a build for
 * a step the operator has not reached. Once DATABASE_URL is set, a migration failure is fatal,
 * which is what you want: serving against a stale schema is worse than a failed deploy.
 *
 * The migration runner itself takes a Postgres advisory lock, so concurrent builds are safe.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../../.env');

if (!process.env.DATABASE_URL && !existsSync(envFile)) {
  console.log(
    '[migrate] DATABASE_URL is not set and no .env file was found — skipping.\n' +
      "[migrate] Set it in your host's environment settings, then redeploy to apply the schema.",
  );
  process.exit(0);
}

let closePool = async () => {};

try {
  // Imported inside the try because loading the config validates the environment and throws
  // a readable summary when something is missing. A build log should show that summary, not
  // a module-loading stack trace.
  const migrate = await import('../dist/db/migrate.js');
  ({ closePool } = await import('../dist/db/pool.js'));

  const { applied } = await migrate.runMigrations();
  console.log(
    applied.length > 0
      ? `[migrate] applied ${applied.length} migration${applied.length === 1 ? '' : 's'}`
      : '[migrate] schema is current',
  );
} catch (error) {
  console.error(`[migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
