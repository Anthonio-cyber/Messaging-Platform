-- Voice and video calls.
--
-- Only call *metadata* lives here. The media itself is peer-to-peer WebRTC, encrypted with
-- DTLS-SRTP between the two devices; it never passes through this server. Where a TURN relay
-- is needed to traverse a restrictive NAT, the relay forwards encrypted packets it cannot
-- read either.

CREATE TYPE call_kind AS ENUM ('audio', 'video');
CREATE TYPE call_status AS ENUM (
  'ringing',    -- offered, not yet answered
  'active',     -- answered, media flowing
  'completed',  -- answered then hung up normally
  'missed',     -- never answered
  'declined',   -- the callee refused it
  'cancelled',  -- the caller gave up before it was answered
  'failed'      -- the connection could not be established
);

CREATE TABLE calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  caller_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  callee_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  kind            call_kind NOT NULL DEFAULT 'audio',
  status          call_status NOT NULL DEFAULT 'ringing',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at     TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  end_reason      TEXT,
  CONSTRAINT calls_not_self CHECK (caller_id IS NULL OR callee_id IS NULL OR caller_id <> callee_id)
);

CREATE INDEX calls_conversation_idx ON calls (conversation_id, started_at DESC);
CREATE INDEX calls_caller_idx ON calls (caller_id, started_at DESC);
CREATE INDEX calls_callee_idx ON calls (callee_id, started_at DESC);
-- Used to reject a second call while one is already up for either party.
CREATE INDEX calls_live_idx ON calls (caller_id, callee_id) WHERE status IN ('ringing', 'active');
