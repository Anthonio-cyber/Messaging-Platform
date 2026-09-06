import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env') });
loadEnv();

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // 32-byte base64 or 64-char hex secrets. Generate with: openssl rand -base64 32
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY must be at least 32 characters'),

  APP_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:4000'),
  IDENTITY_DOMAIN: z.string().default('veylo.chat'),
  BRAND_NAME: z.string().default('Veylo'),
  CORS_ORIGINS: z.string().default(''),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),
  SESSION_IDLE_TIMEOUT_HOURS: z.coerce.number().int().positive().default(168),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  STORAGE_DRIVER: z.enum(['s3', 'local', 'db']).default('local'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: bool(true),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),
  // Ceiling for STORAGE_DRIVER=db. Blobs share the database's size quota with the messages,
  // so an unbounded upload table can take the whole application down rather than just
  // uploads. Default leaves room on a 512 MB managed free tier.
  STORAGE_DB_MAX_BYTES: z.coerce.number().int().positive().default(256 * 1024 * 1024),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Veylo <no-reply@veylo.chat>'),

  RATE_LIMIT_TRUSTED_IPS: z.string().default(''),
  ADMIN_BOOTSTRAP_ADDRESS: z.string().optional(),

  // --- Calls -----------------------------------------------------------------
  // WebRTC media is peer-to-peer and never touches this server. STUN lets two devices
  // discover their public addresses; that is enough for most home networks.
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  // TURN relays media when a restrictive NAT blocks a direct path — roughly one connection
  // in six. Without it those calls simply fail to connect, so a real deployment needs one.
  // The relay only ever forwards DTLS-SRTP packets it cannot decrypt.
  TURN_URLS: z.string().default(''),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  // Cloudflare Realtime issues a fresh credential per user instead of a fixed username and
  // password, so it needs a key rather than a secret. Set these and the server mints a
  // short-lived credential for each call; the three variables above are then unused.
  TURN_KEY_ID: z.string().optional(),
  TURN_KEY_API_TOKEN: z.string().optional(),
  CALLS_ENABLED: bool(true),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail fast and loudly: a half-configured deployment is worse than none.
  throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: raw.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(raw.APP_URL)
    .filter((v, i, arr) => arr.indexOf(v) === i),
  trustedIps: raw.RATE_LIMIT_TRUSTED_IPS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  stunUrls: raw.STUN_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  turnUrls: raw.TURN_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

if (env.isProduction) {
  if (!env.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production (Veylo requires HTTPS).');
  }
  if (env.STORAGE_DRIVER === 'local') {
    // Local disk is not durable on most PaaS hosts; refuse to pretend it is.
    console.warn('[config] STORAGE_DRIVER=local in production: attachments will not survive redeploys.');
  }
  if (env.STORAGE_DRIVER === 'db') {
    // Durable, but it spends the database's quota and connections on file bytes.
    console.warn(
      `[config] STORAGE_DRIVER=db: files live in Postgres, capped at ${Math.floor(
        env.STORAGE_DB_MAX_BYTES / (1024 * 1024),
      )} MB. Move to s3 before that matters.`,
    );
  }

  // Whether a relay is configured decides whether calls work on restrictive networks, and it
  // is set entirely through the environment — so say at boot which way it landed. Otherwise a
  // typo in a TURN variable is invisible until someone's call silently fails to connect.
  if (env.CALLS_ENABLED) {
    if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
      console.log('[config] TURN: minting per-call credentials from Cloudflare Realtime.');
    } else if (env.turnUrls.length > 0 && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      console.log(`[config] TURN: relay configured, ${env.turnUrls.length} URL(s).`);
    } else {
      console.warn(
        '[config] TURN: no relay configured. Calls between restrictive networks will not connect.',
      );
    }
  }
}

export type Env = typeof env;
