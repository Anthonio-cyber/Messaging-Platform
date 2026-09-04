import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scrypt(secret: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

// scrypt parameters. N=2^15 with r=8 costs ~32 MB and ~100 ms per hash on
// commodity hardware, which is the range OWASP recommends for interactive logins.
const PARAMS = { N: 32768, r: 8, p: 1, keyLength: 64, maxmem: 96 * 1024 * 1024 } as const;

/**
 * Hashes the client-derived authenticator (never a raw password - the browser runs
 * Argon2id first, so the plaintext password never reaches this process).
 * Encoded as: scrypt$N$r$p$saltB64$hashB64
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(secret.normalize('NFKC'), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(secret.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same CPU as a real verification. Called when an account does not
 * exist so that response timing does not reveal which identities are registered.
 */
export async function fakeVerify(): Promise<void> {
  await hashSecret(randomBytes(24).toString('base64'));
}

export function generateSalt(bytes = 16): string {
  return randomBytes(bytes).toString('base64');
}
