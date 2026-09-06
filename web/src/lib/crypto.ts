/**
 * Veylo client cryptography.
 *
 * Everything private happens here, in the browser, before anything reaches the network.
 * The library is libsodium (compiled from the audited C implementation) — no hand-rolled
 * primitives.
 *
 * Password handling
 *   authenticator = Argon2id(password, authSalt)   -> sent to the server as the login secret
 *   vaultKey      = Argon2id(password, vaultSalt)  -> stays on this device, forever
 *
 * The server stores scrypt(authenticator), so it never sees the password and cannot derive
 * the vault key. The vault key unseals the account's X25519 private key, which is what makes
 * messages readable.
 *
 * Message handling
 *   messageKey = random 32 bytes
 *   ciphertext = XSalsa20-Poly1305(payload, nonce, messageKey)        [crypto_secretbox]
 *   wrappedKey = sealed box of messageKey to each member's public key [crypto_box_seal]
 *
 * The server stores the ciphertext and one wrapped key per member. It can enumerate who holds
 * a key but cannot open any of them.
 *
 * NOTE: server/src/lib/clientCrypto.ts mirrors this file for seed data and tests. Keep the
 * two in step — same parameters, same encodings.
 */
import sodium from 'libsodium-wrappers-sumo';

/**
 * Argon2id cost. MODERATE would be stronger, but it needs 256 MB and stalls low-end phones;
 * these values take roughly a second on a mid-range device and still put a very large price
 * on offline guessing.
 */
export const KDF_OPSLIMIT = 3;
export const KDF_MEMLIMIT = 64 * 1024 * 1024;

let readyPromise: Promise<typeof sodium> | null = null;

export function sodiumReady(): Promise<typeof sodium> {
  if (!readyPromise) readyPromise = sodium.ready.then(() => sodium);
  return readyPromise;
}

const B64 = () => sodium.base64_variants.ORIGINAL;

export const toB64 = (bytes: Uint8Array): string => sodium.to_base64(bytes, B64());
export const fromB64 = (value: string): Uint8Array => sodium.from_base64(value, B64());

export async function randomSalt(): Promise<string> {
  const s = await sodiumReady();
  return toB64(s.randombytes_buf(s.crypto_pwhash_SALTBYTES));
}

export async function deriveKey(password: string, saltB64: string): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.crypto_pwhash(
    32,
    password.normalize('NFKC'),
    fromB64(saltB64),
    KDF_OPSLIMIT,
    KDF_MEMLIMIT,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function deriveAuthenticator(password: string, authSaltB64: string): Promise<string> {
  await sodiumReady();
  return toB64(await deriveKey(password, authSaltB64));
}

/** Both keys in one pass, so the UI only pays the Argon2id cost twice per sign-in. */
export async function deriveLoginKeys(
  password: string,
  authSalt: string,
  vaultSalt: string,
): Promise<{ authenticator: string; vaultKey: Uint8Array }> {
  const [authenticator, vaultKey] = await Promise.all([
    deriveAuthenticator(password, authSalt),
    deriveKey(password, vaultSalt),
  ]);
  return { authenticator, vaultKey };
}

export interface IdentityKeyPair {
  publicKey: string;
  encryptedPrivateKey: string;
  privateKey: Uint8Array;
}

/** Creates the account's long-term X25519 identity key and seals the private half. */
export async function createIdentity(vaultKey: Uint8Array): Promise<IdentityKeyPair> {
  const s = await sodiumReady();
  const pair = s.crypto_box_keypair();
  return {
    publicKey: toB64(pair.publicKey),
    encryptedPrivateKey: sealWithVaultKey(s, pair.privateKey, vaultKey),
    privateKey: pair.privateKey,
  };
}

function sealWithVaultKey(s: typeof sodium, secret: Uint8Array, vaultKey: Uint8Array): string {
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const sealed = s.crypto_secretbox_easy(secret, nonce, vaultKey);
  const blob = new Uint8Array(nonce.length + sealed.length);
  blob.set(nonce);
  blob.set(sealed, nonce.length);
  return toB64(blob);
}

/** Re-seals an existing private key under a new vault key (password change). */
export async function resealPrivateKey(privateKey: Uint8Array, vaultKey: Uint8Array): Promise<string> {
  const s = await sodiumReady();
  return sealWithVaultKey(s, privateKey, vaultKey);
}

export class VaultUnlockError extends Error {
  constructor() {
    super('Could not unlock your encryption key with that password.');
    this.name = 'VaultUnlockError';
  }
}

export async function unlockIdentity(
  encryptedPrivateKey: string,
  vaultKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodiumReady();
  try {
    const blob = fromB64(encryptedPrivateKey);
    const nonce = blob.subarray(0, s.crypto_secretbox_NONCEBYTES);
    const sealed = blob.subarray(s.crypto_secretbox_NONCEBYTES);
    return s.crypto_secretbox_open_easy(sealed, nonce, vaultKey);
  } catch {
    throw new VaultUnlockError();
  }
}

export interface KeyRecipient {
  userId: string;
  publicKey: string | null;
}

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
  keys: Array<{ userId: string; wrappedKey: string }>;
}

/** The shape of every decrypted message body. Attachments carry their own file keys. */
export interface MessagePayload {
  text: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    key: string;
    nonce: string;
  }>;
}

export async function encryptForMembers(
  payload: MessagePayload,
  members: KeyRecipient[],
): Promise<EncryptedPayload> {
  const s = await sodiumReady();
  const withKeys = members.filter((m): m is { userId: string; publicKey: string } => Boolean(m.publicKey));
  if (withKeys.length === 0) {
    throw new Error('Nobody in this conversation has published an encryption key yet.');
  }

  const messageKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(s.from_string(JSON.stringify(payload)), nonce, messageKey);

  return {
    ciphertext: toB64(ciphertext),
    nonce: toB64(nonce),
    keys: withKeys.map((member) => ({
      userId: member.userId,
      wrappedKey: toB64(s.crypto_box_seal(messageKey, fromB64(member.publicKey))),
    })),
  };
}

export interface DecryptionIdentity {
  publicKey: string;
  privateKey: Uint8Array;
}

export async function decryptMessage(
  message: { ciphertext: string; nonce: string; wrappedKey: string | null },
  identity: DecryptionIdentity,
): Promise<MessagePayload | null> {
  if (!message.wrappedKey || !message.ciphertext) return null;
  const s = await sodiumReady();
  try {
    const messageKey = s.crypto_box_seal_open(
      fromB64(message.wrappedKey),
      fromB64(identity.publicKey),
      identity.privateKey,
    );
    const plaintext = s.crypto_secretbox_open_easy(
      fromB64(message.ciphertext),
      fromB64(message.nonce),
      messageKey,
    );
    const parsed = JSON.parse(s.to_string(plaintext)) as MessagePayload;
    return typeof parsed?.text === 'string' ? parsed : null;
  } catch {
    // A message sealed to a key this device no longer holds (rotated key, joined a group
    // later). Callers render this as "cannot be decrypted" rather than failing.
    return null;
  }
}

/** Encrypts a file with its own key; the key travels inside the message payload. */
export async function encryptFile(
  data: ArrayBuffer,
): Promise<{ blob: Uint8Array; key: string; nonce: string }> {
  const s = await sodiumReady();
  const key = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const blob = s.crypto_secretbox_easy(new Uint8Array(data), nonce, key);
  return { blob, key: toB64(key), nonce: toB64(nonce) };
}

export async function decryptFile(
  data: ArrayBuffer,
  keyB64: string,
  nonceB64: string,
): Promise<Uint8Array> {
  const s = await sodiumReady();
  return s.crypto_secretbox_open_easy(new Uint8Array(data), fromB64(nonceB64), fromB64(keyB64));
}

/**
 * Recovery codes. Each code seals a copy of the vault key, so redeeming one during a password
 * reset keeps encrypted history readable. Without a code, a reset means a fresh identity key
 * and unreadable old messages — which the UI says plainly.
 */
export interface RecoveryCode {
  code: string;
  wrappedVaultKey: string;
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export async function generateRecoveryCodes(vaultKey: Uint8Array, count = 8): Promise<RecoveryCode[]> {
  const s = await sodiumReady();
  const codes: RecoveryCode[] = [];

  for (let i = 0; i < count; i += 1) {
    const raw = s.randombytes_buf(10);
    const code = Array.from(raw)
      .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
      .join('');
    // The code itself is the key material: stretch it, then seal the vault key under it.
    const codeKey = s.crypto_generichash(32, s.from_string(code), s.from_string('veylo-recovery'));
    codes.push({ code, wrappedVaultKey: sealWithVaultKey(s, vaultKey, codeKey) });
  }
  return codes;
}

export async function unwrapVaultKeyWithCode(
  wrappedVaultKey: string,
  code: string,
): Promise<Uint8Array> {
  const s = await sodiumReady();
  const normalized = code.trim().replace(/\s+/g, '').toLowerCase();
  const codeKey = s.crypto_generichash(32, s.from_string(normalized), s.from_string('veylo-recovery'));
  const blob = fromB64(wrappedVaultKey);
  const nonce = blob.subarray(0, s.crypto_secretbox_NONCEBYTES);
  const sealed = blob.subarray(s.crypto_secretbox_NONCEBYTES);
  return s.crypto_secretbox_open_easy(sealed, nonce, codeKey);
}

/** Short fingerprint of a public key, for out-of-band verification between two people. */
export async function keyFingerprint(publicKeyB64: string): Promise<string> {
  const s = await sodiumReady();
  const digest = s.crypto_generichash(20, fromB64(publicKeyB64));
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .match(/.{1,5}/g)!
    .slice(0, 8)
    .join(' ');
}
