/**
 * Copies every object out of the `db` storage driver and into an S3-compatible bucket.
 *
 *   STORAGE_BUCKET=… STORAGE_ACCESS_KEY=… STORAGE_SECRET_KEY=… \
 *   STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
 *   node server/scripts/migrate-storage.mjs
 *
 * Storage keys are identical under both drivers, so this is a straight copy — no rows in
 * `attachments` or `users` need rewriting. Run it with the app still serving on
 * STORAGE_DRIVER=db: every object stays readable from the table until you flip the driver, so
 * there is no window where a file resolves to neither place.
 *
 * Safe to re-run. It skips objects already in the bucket at the same size, so an interrupted
 * run picks up where it stopped rather than re-uploading everything.
 *
 * Once STORAGE_DRIVER=s3 is live and downloads work, `DROP TABLE storage_objects` reclaims
 * the space. Do that only after you have confirmed it, not in the same change.
 */
import pg from 'pg';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const {
  DATABASE_URL,
  DATABASE_SSL,
  STORAGE_BUCKET,
  STORAGE_ACCESS_KEY,
  STORAGE_SECRET_KEY,
  STORAGE_ENDPOINT,
  STORAGE_REGION = 'auto',
  STORAGE_FORCE_PATH_STYLE = 'true',
} = process.env;

const missing = Object.entries({
  DATABASE_URL,
  STORAGE_BUCKET,
  STORAGE_ACCESS_KEY,
  STORAGE_SECRET_KEY,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(`Missing required environment: ${missing.join(', ')}`);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const s3 = new S3Client({
  region: STORAGE_REGION,
  endpoint: STORAGE_ENDPOINT || undefined,
  forcePathStyle: STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: STORAGE_ACCESS_KEY, secretAccessKey: STORAGE_SECRET_KEY },
});

/** Already there at the same size? Then a previous run copied it. */
async function alreadyUploaded(key, size) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }));
    return head.ContentLength === size;
  } catch {
    return false;
  }
}

let copied = 0;
let skipped = 0;
let failed = 0;

try {
  // Paginate by key rather than OFFSET: bodies are large, and holding one page at a time keeps
  // peak memory to a single batch instead of the whole table.
  let after = '';
  for (;;) {
    const { rows } = await pool.query(
      `SELECT key, content_type, byte_size, body
         FROM storage_objects
        WHERE key > $1
        ORDER BY key
        LIMIT 20`,
      [after],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1].key;

    for (const row of rows) {
      if (await alreadyUploaded(row.key, row.byte_size)) {
        skipped += 1;
        continue;
      }
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: STORAGE_BUCKET,
            Key: row.key,
            Body: row.body,
            ContentType: row.content_type,
            ServerSideEncryption: STORAGE_ENDPOINT ? undefined : 'AES256',
          }),
        );
        copied += 1;
        if (copied % 25 === 0) console.log(`  copied ${copied}…`);
      } catch (error) {
        failed += 1;
        console.error(`  FAILED ${row.key}: ${error.message}`);
      }
    }
  }

  console.log(`\nCopied ${copied}, already present ${skipped}, failed ${failed}.`);
  if (failed > 0) {
    console.error('Some objects did not copy. Re-run to retry only those; do not switch drivers yet.');
    process.exitCode = 1;
  } else {
    console.log('Set STORAGE_DRIVER=s3 and redeploy. Verify a download, then drop storage_objects.');
  }
} finally {
  await pool.end();
}
