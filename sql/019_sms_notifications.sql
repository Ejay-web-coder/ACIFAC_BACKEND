-- Text messages through a textbee Android phone gateway (src/services/smsService.js).
-- Password reset codes are texted straight away; loan payment reminders are
-- queued in sms_outbox and sent during the day.

-- 1. SMS is on unless the account switches it off ------------------------------
-- The setting existed before SMS could be delivered, defaulting to off, so no
-- stored "off" is a real choice yet. Everyone starts with it on.
ALTER TABLE users ALTER COLUMN notification_preferences
  SET DEFAULT '{"emailNotifications": true, "smsNotifications": true, "loanReminders": true}'::jsonb;
UPDATE users SET notification_preferences = notification_preferences || '{"smsNotifications": true}'::jsonb;

-- 2. Queued texts ---------------------------------------------------------------
-- One row per text. `phone` is the number it was queued for, already in
-- +639XXXXXXXXX form. A text the gateway did not accept waits until retry_at
-- and is tried again, up to the attempt limit in smsService.js; texts still
-- unsent after two days are marked expired rather than sent late.
CREATE TABLE IF NOT EXISTS sms_outbox (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_pending ON sms_outbox(retry_at, id) WHERE status = 'pending';

-- 3. Same protection as every other table (see 012 section 4) -----------------
DO $$
BEGIN
  ALTER TABLE sms_outbox ENABLE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE sms_outbox FROM anon, authenticated;
  END IF;
END $$;

-- Reversal (manual, only if needed):
--   DROP TABLE sms_outbox;
--   ALTER TABLE users ALTER COLUMN notification_preferences
--     SET DEFAULT '{"emailNotifications": true, "smsNotifications": false, "loanReminders": true}'::jsonb;
