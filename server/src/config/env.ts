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
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: bool(true),
  STORAGE_LOCAL_DIR: z.string().default('./uploads'),

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
}

export type Env = typeof env;
