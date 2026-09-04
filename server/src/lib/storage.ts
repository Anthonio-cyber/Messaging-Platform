import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { serverError } from './errors.js';

export interface StoredObject {
  key: string;
  size: number;
}

export interface StorageDriver {
  readonly kind: 's3' | 'local';
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  getStream(key: string): Promise<Readable>;
  /** Short-lived direct URL, or null when downloads must be proxied through the API. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string | null>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(process.cwd(), dir);
  }

  /** Confines every key to the storage root — no traversal out of it. */
  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw serverError('Invalid storage key.');
    }
    return target;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<StoredObject> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { mode: 0o600 });
    return { key, size: body.byteLength };
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.resolve(key);
    await fs.access(target);
    return createReadStream(target);
  }

  async signedUrl(): Promise<string | null> {
    // Local files are always served through the authorising API route.
    return null;
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    if (!env.STORAGE_BUCKET || !env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires STORAGE_BUCKET, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY.',
      );
    }
    this.bucket = env.STORAGE_BUCKET;
    this.client = new S3Client({
      region: env.STORAGE_REGION,
      endpoint: env.STORAGE_ENDPOINT || undefined,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.STORAGE_ACCESS_KEY,
        secretAccessKey: env.STORAGE_SECRET_KEY,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Attachments arrive already encrypted by the sender's browser; SSE is defence in depth.
        ServerSideEncryption: env.STORAGE_ENDPOINT ? undefined : 'AES256',
      }),
    );
    return { key, size: body.byteLength };
  }

  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw serverError('Object body missing.');
    return result.Body as Readable;
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export const storage: StorageDriver =
  env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(env.STORAGE_LOCAL_DIR);

// Attachments are encrypted client-side, so the server sees opaque bytes. The allowlist
// applies to the declared category, and the byte cap is enforced on the raw upload.
export const ALLOWED_CATEGORIES = new Set(['image', 'video', 'audio', 'document', 'file']);

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'jar', 'js', 'jse', 'vbs', 'vbe',
  'wsf', 'wsh', 'ps1', 'psm1', 'apk', 'app', 'dmg', 'deb', 'rpm', 'sh', 'bash', 'dll', 'sys',
]);

export function isBlockedFilename(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return BLOCKED_EXTENSIONS.has(ext);
}

/**
 * Hook point for a malware scanner (ClamAV, VirusTotal, a vendor API). Payloads reaching
 * here are client-side ciphertext, so a content scanner cannot inspect them; scanning must
 * run on the recipient's device after decryption, or on plaintext uploads if that mode is
 * ever enabled. Marked "skipped" rather than falsely reported as "clean".
 */
export async function scanUpload(_body: Buffer): Promise<'clean' | 'rejected' | 'skipped'> {
  return 'skipped';
}
