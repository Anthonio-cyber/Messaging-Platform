import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { env } from '../config/env.js';

/** Accepts a base64 or hex secret and folds it into a fixed 32-byte key. */
function deriveKey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret).update(`veylo:${label}`).digest();
}

const DATA_KEY = deriveKey(env.DATA_ENCRYPTION_KEY, 'data-at-rest');
const INDEX_KEY = deriveKey(env.AUTH_SECRET, 'blind-index');
const TOKEN_KEY = deriveKey(env.AUTH_SECRET, 'token');

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptField(encoded: string | null): string | null {
  if (!encoded) return null;
  const [version, ivB64, tagB64, dataB64] = encoded.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', DATA_KEY, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Deterministic keyed hash used to look up encrypted values (recovery emails) and to
 * bucket rate limits without storing the raw identifier or IP address.
 */
export function blindIndex(value: string): string {
  return createHmac('sha256', INDEX_KEY).update(value.trim().toLowerCase()).digest('base64url');
}

/** Session and reset tokens: a long random secret, stored only as a keyed hash. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHmac('sha256', TOKEN_KEY).update(token).digest('base64url');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export { randomUUID };
