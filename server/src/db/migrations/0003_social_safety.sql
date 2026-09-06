-- Message requests, blocking, reporting, notifications and admin audit trail.

CREATE TYPE request_status AS ENUM ('pending', 'accepted', 'declined', 'blocked');

CREATE TABLE message_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          request_status NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at    TIMESTAMPTZ,
  CONSTRAINT message_requests_not_self CHECK (sender_id <> recipient_id)
);
CREATE UNIQUE INDEX message_requests_pair_pending
  ON message_requests (sender_id, recipient_id) WHERE status = 'pending';
CREATE INDEX message_requests_recipient_idx ON message_requests (recipient_id, status, created_at DESC);
CREATE INDEX message_requests_sender_idx ON message_requests (sender_id, status);

CREATE TABLE blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

-- Accepted requests create a mutual contact edge, which privacy rules key off.
CREATE TABLE contacts (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_id),
  CONSTRAINT contacts_not_self CHECK (user_id <> contact_id)
);

CREATE TYPE report_status AS ENUM ('open', 'reviewing', 'resolved', 'dismissed');
CREATE TYPE report_target AS ENUM ('user', 'message', 'conversation');

CREATE TABLE reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  target_type     report_target NOT NULL,
  reported_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  category        TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  -- Messages are end-to-end encrypted, so the reporter attaches a plaintext excerpt
  -- from their own device. Nothing is decrypted server-side.
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          report_status NOT NULL DEFAULT 'open',
  handled_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX reports_reported_user_idx ON reports (reported_user_id);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE admin_actions (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  note        TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_created_idx ON admin_actions (created_at DESC);

-- Reserved usernames that must never be handed out as identities.
CREATE TABLE reserved_usernames (
  username CITEXT PRIMARY KEY,
  reason   TEXT NOT NULL DEFAULT 'reserved'
);
INSERT INTO reserved_usernames (username, reason) VALUES
  ('admin','system'), ('administrator','system'), ('root','system'), ('support','system'),
  ('help','system'), ('security','system'), ('abuse','system'), ('postmaster','system'),
  ('noreply','system'), ('no-reply','system'), ('veylo','brand'), ('team','brand'),
  ('official','brand'), ('system','system'), ('moderator','system'), ('billing','system'),
  ('legal','system'), ('privacy','system'), ('api','system'), ('www','system'),
  ('app','system'), ('auth','system'), ('mail','system'), ('null','system')
ON CONFLICT DO NOTHING;
