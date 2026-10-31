-- Conversations, membership, messages and delivery state.

CREATE TYPE conversation_type AS ENUM ('direct', 'group');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            conversation_type NOT NULL,
  title           TEXT,
  description     TEXT NOT NULL DEFAULT '',
  avatar_key      TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Direct chats and groups both use per-message sealed key wraps.
  is_e2ee         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Group permission matrix: who_can_send / who_can_add / who_can_edit_info / who_can_invite
  permissions     JSONB NOT NULL DEFAULT
                    '{"who_can_send":"everyone","who_can_add":"admins","who_can_edit_info":"admins","who_can_invite":"admins"}'::jsonb,
  -- Sorted "a:b" user id pair; enforces exactly one direct conversation per pair.
  direct_key      TEXT,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT conversations_direct_key_shape
    CHECK ((type = 'direct' AND direct_key IS NOT NULL) OR (type = 'group' AND direct_key IS NULL))
);
CREATE UNIQUE INDEX conversations_direct_key_uniq ON conversations (direct_key) WHERE direct_key IS NOT NULL;
CREATE INDEX conversations_recent_idx ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE conversation_members (
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 member_role NOT NULL DEFAULT 'member',
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at              TIMESTAMPTZ,
  invited_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  muted_until          TIMESTAMPTZ,
  archived_at          TIMESTAMPTZ,
  pinned_at            TIMESTAMPTZ,
  -- Membership is only live once the message request is accepted.
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_read_message_id UUID,
  manually_unread      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id) WHERE left_at IS NULL;

CREATE TYPE message_kind AS ENUM ('text', 'attachment', 'system');

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  kind             message_kind NOT NULL DEFAULT 'text',
  -- Base64 XChaCha20-Poly1305 ciphertext of the message payload. The server cannot read it.
  ciphertext       TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  -- System notices (joins, renames) are not user speech and are stored readable.
  system_payload   JSONB,
  reply_to_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  forwarded_from   UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  deleted_for_all  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX messages_sender_idx ON messages (sender_id, created_at DESC);
CREATE INDEX messages_reply_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;

-- One sealed copy of the message key per member who is allowed to read it.
CREATE TABLE message_keys (
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE message_status (
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at      TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_status_unread_idx ON message_status (user_id) WHERE read_at IS NULL;

CREATE TABLE message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE pinned_messages (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  pinned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      UUID REFERENCES messages(id) ON DELETE CASCADE,
  storage_key     TEXT NOT NULL UNIQUE,
  byte_size       BIGINT NOT NULL,
  mime_type       TEXT NOT NULL,
  -- Filenames travel inside the encrypted message payload; only a coarse category is stored here.
  category        TEXT NOT NULL DEFAULT 'file',
  scan_status     TEXT NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending', 'clean', 'rejected', 'skipped')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_conversation_idx ON attachments (conversation_id, created_at DESC);
CREATE INDEX attachments_orphan_idx ON attachments (created_at) WHERE message_id IS NULL;

CREATE TABLE invite_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  code            TEXT NOT NULL UNIQUE,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ,
  max_uses        INTEGER,
  use_count       INTEGER NOT NULL DEFAULT 0,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invite_links_conversation_idx ON invite_links (conversation_id) WHERE revoked_at IS NULL;
