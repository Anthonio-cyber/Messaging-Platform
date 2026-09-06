/**
 * Development mirror of the browser's crypto layer (web/src/lib/crypto.ts).
 *
 * Used ONLY by the seed script and the integration tests, so fixtures are created exactly the
 * way a real browser creates them — same Argon2id parameters, same sealed-box construction.
 * Nothing in the running server imports this: the server never derives keys or handles
 * plaintext. If the browser implementation changes, change this too.
 */
import sodium from 'libsodium-wrappers-sumo';

export const KDF_OPSLIMIT = 3;
export const KDF_MEMLIMIT = 64 * 1024 * 1024;

export async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export async function randomSalt(): Promise<string> {
  const s = await ready();
  return s.to_base64(s.randombytes_buf(s.crypto_pwhash_SALTBYTES), s.base64_variants.ORIGINAL);
}

/** Argon2id(password, salt) -> 32 bytes. */
export async function deriveKey(password: string, saltB64: string): Promise<Uint8Array> {
  const s = await ready();
  return s.crypto_pwhash(
    32,
    password.normalize('NFKC'),
    s.from_base64(saltB64, s.base64_variants.ORIGINAL),
    KDF_OPSLIMIT,
    KDF_MEMLIMIT,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export async function deriveAuthenticator(password: string, authSaltB64: string): Promise<string> {
  const s = await ready();
  return s.to_base64(await deriveKey(password, authSaltB64), s.base64_variants.ORIGINAL);
}

export interface IdentityKeys {
  publicKey: string;
  encryptedPrivateKey: string;
}

export async function createIdentity(vaultKey: Uint8Array): Promise<IdentityKeys & { privateKey: Uint8Array }> {
  const s = await ready();
  const pair = s.crypto_box_keypair();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const sealed = s.crypto_secretbox_easy(pair.privateKey, nonce, vaultKey);
  const blob = new Uint8Array(nonce.length + sealed.length);
  blob.set(nonce);
  blob.set(sealed, nonce.length);
  return {
    publicKey: s.to_base64(pair.publicKey, s.base64_variants.ORIGINAL),
    encryptedPrivateKey: s.to_base64(blob, s.base64_variants.ORIGINAL),
    privateKey: pair.privateKey,
  };
}

export async function unlockIdentity(encryptedPrivateKey: string, vaultKey: Uint8Array): Promise<Uint8Array> {
  const s = await ready();
  const blob = s.from_base64(encryptedPrivateKey, s.base64_variants.ORIGINAL);
  const nonce = blob.subarray(0, s.crypto_secretbox_NONCEBYTES);
  const sealed = blob.subarray(s.crypto_secretbox_NONCEBYTES);
  return s.crypto_secretbox_open_easy(sealed, nonce, vaultKey);
}

export interface EncryptedMessage {
  ciphertext: string;
  nonce: string;
  keys: Array<{ userId: string; wrappedKey: string }>;
}

/** Encrypts once with a fresh message key, then seals that key to each member. */
export async function encryptForMembers(
  payload: unknown,
  members: Array<{ userId: string; publicKey: string }>,
): Promise<EncryptedMessage> {
  const s = await ready();
  const messageKey = s.randombytes_buf(s.crypto_secretbox_KEYBYTES);
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const ciphertext = s.crypto_secretbox_easy(
    s.from_string(JSON.stringify(payload)),
    nonce,
    messageKey,
  );
  return {
    ciphertext: s.to_base64(ciphertext, s.base64_variants.ORIGINAL),
    nonce: s.to_base64(nonce, s.base64_variants.ORIGINAL),
    keys: members.map((member) => ({
      userId: member.userId,
      wrappedKey: s.to_base64(
        s.crypto_box_seal(messageKey, s.from_base64(member.publicKey, s.base64_variants.ORIGINAL)),
        s.base64_variants.ORIGINAL,
      ),
    })),
  };
}

export async function decryptMessage(
  ciphertextB64: string,
  nonceB64: string,
  wrappedKeyB64: string,
  publicKeyB64: string,
  privateKey: Uint8Array,
): Promise<unknown> {
  const s = await ready();
  const messageKey = s.crypto_box_seal_open(
    s.from_base64(wrappedKeyB64, s.base64_variants.ORIGINAL),
    s.from_base64(publicKeyB64, s.base64_variants.ORIGINAL),
    privateKey,
  );
  const plaintext = s.crypto_secretbox_open_easy(
    s.from_base64(ciphertextB64, s.base64_variants.ORIGINAL),
    s.from_base64(nonceB64, s.base64_variants.ORIGINAL),
    messageKey,
  );
  return JSON.parse(s.to_string(plaintext));
}

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export interface RecoveryCode {
  code: string;
  wrappedVaultKey: string;
}

/** Mirrors generateRecoveryCodes in web/src/lib/crypto.ts. */
export async function generateRecoveryCodes(vaultKey: Uint8Array, count = 8): Promise<RecoveryCode[]> {
  const s = await ready();
  const codes: RecoveryCode[] = [];

  for (let i = 0; i < count; i += 1) {
    const raw = s.randombytes_buf(10);
    const code = Array.from(raw)
      .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
      .join('');
    const codeKey = s.crypto_generichash(32, s.from_string(code), s.from_string('veylo-recovery'));
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
    const sealed = s.crypto_secretbox_easy(vaultKey, nonce, codeKey);
    const blob = new Uint8Array(nonce.length + sealed.length);
    blob.set(nonce);
    blob.set(sealed, nonce.length);
    codes.push({ code, wrappedVaultKey: s.to_base64(blob, s.base64_variants.ORIGINAL) });
  }
  return codes;
}

export async function unwrapVaultKeyWithCode(wrappedVaultKey: string, code: string): Promise<Uint8Array> {
  const s = await ready();
  const normalized = code.trim().replace(/\s+/g, '').toLowerCase();
  const codeKey = s.crypto_generichash(32, s.from_string(normalized), s.from_string('veylo-recovery'));
  const blob = s.from_base64(wrappedVaultKey, s.base64_variants.ORIGINAL);
  const nonce = blob.subarray(0, s.crypto_secretbox_NONCEBYTES);
  const sealed = blob.subarray(s.crypto_secretbox_NONCEBYTES);
  return s.crypto_secretbox_open_easy(sealed, nonce, codeKey);
}

/** Re-seals an existing private key under a new vault key (password change or reset). */
export async function resealPrivateKey(privateKey: Uint8Array, vaultKey: Uint8Array): Promise<string> {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES);
  const sealed = s.crypto_secretbox_easy(privateKey, nonce, vaultKey);
  const blob = new Uint8Array(nonce.length + sealed.length);
  blob.set(nonce);
  blob.set(sealed, nonce.length);
  return s.to_base64(blob, s.base64_variants.ORIGINAL);
}
