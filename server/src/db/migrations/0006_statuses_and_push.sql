-- Status posts, and push notification subscriptions.
--
-- A status is a short post that expires after 24 hours. It is encrypted the same way a group
-- message is: one sealed copy of the content key per person allowed to read it. That choice
-- settles the audience question before it is asked — per-recipient key wrapping cannot address
-- an unbounded "everyone", so a status goes to the author's contacts and nobody else. The
-- audience is fixed at post time, which means someone added as a contact tomorrow cannot read
-- a status posted today. There is no key for them on it, anywhere.

CREATE TYPE status_kind AS ENUM ('text', 'image');

CREATE TABLE statuses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        status_kind NOT NULL DEFAULT 'text',
  -- Opaque to this server: the payload (caption, background colour, media key) is sealed
  -- client-side and only the wrapped keys below can open it.
  ciphertext  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX statuses_author_idx ON statuses (author_id, created_at DESC);
-- The read path is always "live statuses, newest first", so the partial index matches it.
CREATE INDEX statuses_live_idx ON statuses (expires_at) WHERE deleted_at IS NULL;

CREATE TABLE status_keys (
  status_id   UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (status_id, user_id)
);

-- Who has opened a status. Shown to the author, but only for viewers whose own read-receipt
-- setting is on — the same bargain the rest of the app makes: see receipts, give receipts.
CREATE TABLE status_views (
  status_id UUID NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (status_id, viewer_id)
);

-- Image bodies for statuses. Separate from `attachments`, which is scoped to a conversation
-- and authorised by membership in one; a status has no conversation, and is authorised by
-- holding a key for it instead.
CREATE TABLE status_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status_id   UUID REFERENCES statuses(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX status_media_status_idx ON status_media (status_id);
-- Uploads that were never attached to a status are swept; this finds them cheaply.
CREATE INDEX status_media_orphan_idx ON status_media (created_at) WHERE status_id IS NULL;

ALTER TABLE privacy_settings
  ADD COLUMN status_audience TEXT NOT NULL DEFAULT 'contacts'
    CHECK (status_audience IN ('contacts', 'nobody'));

COMMENT ON COLUMN privacy_settings.status_audience IS
  'Who receives a key when this account posts a status. "everyone" is deliberately absent: keys are wrapped per recipient, so an unbounded audience is not expressible.';

-- ---------------------------------------------------------------------------
-- Push subscriptions
-- ---------------------------------------------------------------------------
--
-- One row per browser that asked to be notified while Veylo is closed. The endpoint belongs
-- to the browser vendor's push service, and p256dh/auth are that browser's public key material
-- for RFC 8291 payload encryption — so the push service relays a payload it cannot read.
--
-- What it can see is who is being messaged, and when. That is unavoidable with Web Push and is
-- stated plainly in the UI rather than papered over.

CREATE TABLE push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Unique across accounts: a browser that signs in as someone else must not keep delivering
  -- to the previous account, so the insert reassigns the row rather than duplicating it.
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  -- A subscription the push service rejects as gone is deleted immediately; this counts the
  -- softer failures so a persistently broken endpoint can be retired too.
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
