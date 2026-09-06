-- Object storage inside Postgres.
--
-- The `local` driver writes to disk, which most PaaS hosts wipe on every restart, so avatars
-- and attachments quietly vanish. An S3-compatible bucket is the right answer at any real
-- size, but it needs an account, a bucket and a key pair — and a deployment without one
-- should not silently lose files in the meantime.
--
-- So: a driver that keeps the bytes here. Uploads are already ciphertext (attachments) or
-- small images (avatars, capped at 2 MB), so this is a blob table, not a document store.
-- Postgres TOASTs anything past ~2 KB into out-of-line storage automatically.
--
-- The honest limits, which STORAGE_DB_MAX_BYTES exists to keep you inside:
--   - Every read and write goes through the database connection, so throughput is bounded by
--     it, and a large file occupies a connection for as long as it takes to send.
--   - Blobs count against the database's size quota, and on a managed free tier that quota is
--     also what keeps messages working. Filling it with pictures takes the whole app down,
--     not just uploads — hence a ceiling that refuses the upload instead.
--   - There is no signed-URL path, so downloads cannot be offloaded to a CDN.

CREATE TABLE storage_objects (
  key          text PRIMARY KEY,
  content_type text        NOT NULL,
  byte_size    integer     NOT NULL CHECK (byte_size >= 0),
  body         bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Keep the blobs out of line unconditionally: compressing ciphertext and JPEG data wastes CPU
-- to no effect, and the row itself stays small enough to scan cheaply for the size accounting.
ALTER TABLE storage_objects ALTER COLUMN body SET STORAGE EXTERNAL;

COMMENT ON TABLE storage_objects IS
  'Blob store for STORAGE_DRIVER=db. Attachment bodies are client-side ciphertext; avatars are plaintext images by necessity.';
