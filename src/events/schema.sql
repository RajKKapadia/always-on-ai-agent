CREATE TABLE IF NOT EXISTS inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  finished_at timestamptz,
  failed boolean NOT NULL DEFAULT false,
  reply text
);
CREATE INDEX IF NOT EXISTS inbox_pending_idx
  ON inbox (available_at, created_at) WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id uuid PRIMARY KEY REFERENCES inbox(id),
  chat_id text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  finished_at timestamptz,
  failed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS telegram_outbox_pending_idx
  ON telegram_outbox (available_at, created_at) WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS conversation_turns (
  id uuid PRIMARY KEY REFERENCES inbox(id),
  chat_id text NOT NULL,
  message text NOT NULL,
  reply text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz,
  index_after timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_chat_idx ON conversation_turns (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_unindexed_idx
  ON conversation_turns (index_after) WHERE indexed_at IS NULL;

CREATE TABLE IF NOT EXISTS action_approvals (
  id uuid PRIMARY KEY REFERENCES inbox(id),
  chat_id text,
  action jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  decision text CHECK (decision IN ('approve', 'deny')),
  decided_by uuid UNIQUE REFERENCES inbox(id),
  decided_at timestamptz
);

ALTER TABLE telegram_outbox
  ADD COLUMN IF NOT EXISTS approval_id uuid REFERENCES action_approvals(id);

-- Webhook deliveries prepared before approval was introduced must be proposed again.
WITH legacy AS (
  UPDATE telegram_outbox AS delivery
  SET finished_at = now(), failed = true, lease_until = NULL
  FROM inbox AS original
  WHERE delivery.id = original.id AND delivery.finished_at IS NULL
    AND delivery.approval_id IS NULL AND original.event->>'kind' = 'webhook'
  RETURNING original.id, original.event
)
INSERT INTO inbox (event_key, event)
SELECT 'webhook-approval:' || id::text, event FROM legacy
ON CONFLICT (event_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS personal_memories (
  chat_id text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, key)
);
