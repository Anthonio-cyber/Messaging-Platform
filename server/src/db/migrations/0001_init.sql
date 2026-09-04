-- Veylo core schema
-- Identity, privacy, conversations, messaging, moderation and security auditing.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('user', 'moderator', 'admin');
CREATE TYPE account_status AS ENUM ('active', 'suspended', 'banned', 'deleted');

CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username               CITEXT NOT NULL,
  custom_address         CITEXT NOT NULL,
  display_name           TEXT NOT NULL,
  -- Server-side verifier over the client-derived authenticator (never a raw password).
  password_hash          TEXT NOT NULL,
  -- Per-account salts handed to the client so it can derive the login authenticator
  -- and the local vault key. Public by necessity; useless without the password.
  auth_salt              TEXT NOT NULL,
  vault_salt             TEXT NOT NULL,
  password_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- X25519 identity key. The private half is sealed with the vault key on the client.
  public_key             TEXT,
  encrypted_private_key  TEXT,
  avatar_key             TEXT,
  bio                    TEXT NOT NULL DEFAULT '',
  presence               TEXT NOT NULL DEFAULT 'offline'
                           CHECK (presence IN ('online', 'away', 'offline')),
  last_seen_at           TIMESTAMPTZ,
  role                   user_role NOT NULL DEFAULT 'user',
  status                 account_status NOT NULL DEFAULT 'active',
  suspended_until        TIMESTAMPTZ,
  moderation_note        TEXT,
  -- Recovery address is encrypted at rest; the blind index supports lookup without decryption.
  recovery_email_enc     TEXT,
  recovery_email_index   TEXT,
  recovery_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_count     INTEGER NOT NULL DEFAULT 0,
  locked_until           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9](?:[a-z0-9_.-]{1,30})[a-z0-9]$')
);

CREATE UNIQUE INDEX users_username_key ON users (username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_custom_address_key ON users (custom_address) WHERE deleted_at IS NULL;
CREATE INDEX users_recovery_email_index_idx ON users (recovery_email_index) WHERE recovery_email_index IS NOT NULL;
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX users_display_name_idx ON users (lower(display_name));

CREATE TABLE privacy_settings (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  who_can_contact        TEXT NOT NULL DEFAULT 'approved'
                           CHECK (who_can_contact IN ('everyone', 'approved', 'nobody')),
  online_status_visible  TEXT NOT NULL DEFAULT 'contacts'
                           CHECK (online_status_visible IN ('everyone', 'contacts', 'nobody')),
  last_seen_visible      TEXT NOT NULL DEFAULT 'contacts'
                           CHECK (last_seen_visible IN ('everyone', 'contacts', 'nobody')),
  avatar_visible         TEXT NOT NULL DEFAULT 'everyone'
                           CHECK (avatar_visible IN ('everyone', 'contacts', 'nobody')),
  profile_visible        TEXT NOT NULL DEFAULT 'everyone'
                           CHECK (profile_visible IN ('everyone', 'contacts', 'nobody')),
  discoverable           BOOLEAN NOT NULL DEFAULT TRUE,
  read_receipts          BOOLEAN NOT NULL DEFAULT TRUE,
  typing_indicators      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Sessions and account security
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  device_label   TEXT NOT NULL DEFAULT 'Unknown device',
  user_agent     TEXT,
  ip_hash        TEXT,
  approx_location TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id, revoked_at);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TYPE token_purpose AS ENUM ('password_reset', 'email_verify', 'account_delete');

CREATE TABLE auth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     token_purpose NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);

CREATE TABLE recovery_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  -- The vault key sealed under this recovery code, so a password reset can keep
  -- end-to-end encrypted history readable. Null means history is lost on reset.
  wrapped_vault_key TEXT,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE login_attempts (
  id              BIGSERIAL PRIMARY KEY,
  identifier_hash TEXT NOT NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_hash         TEXT NOT NULL,
  user_agent      TEXT,
  successful      BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_identifier_idx ON login_attempts (identifier_hash, created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_hash, created_at DESC);

CREATE TABLE security_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  ip_hash    TEXT,
  user_agent TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_idx ON security_events (user_id, created_at DESC);
CREATE INDEX security_events_type_idx ON security_events (event_type, created_at DESC);
