-- Administrator accounts made in Manage Users.
--
-- Every administrator has the one ADMIN role, but a name and a position in the
-- cooperative of their own (users.full_name, users.position: Chairperson,
-- Treasurer, ...). The audit log keeps the position the person held when they
-- acted, next to their username and full name, so each entry says who did it
-- in which office even after positions change.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_position_snapshot VARCHAR(120);

-- Who made an administrator account (NULL for the first one, made with npm run create-admin).
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- One-time codes that prove a new administrator's email and mobile number
-- reach them, sent while the account is being made. A code works for 10
-- minutes and 5 tries; once verified, the address can be used for one account
-- within 30 minutes, by the administrator who asked for the code.
CREATE TABLE IF NOT EXISTS contact_verifications (
  id BIGSERIAL PRIMARY KEY,
  purpose VARCHAR(30) NOT NULL DEFAULT 'admin_account',
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('email', 'sms')),
  target VARCHAR(255) NOT NULL,
  code_hash TEXT NOT NULL,
  requested_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_verifications_requester ON contact_verifications (requested_by, created_at DESC);

COMMENT ON COLUMN audit_logs.user_position_snapshot IS 'Position in the cooperative of the administrator who acted, as it was at that moment.';
COMMENT ON COLUMN users.created_by IS 'The administrator who made this account in Manage Users.';
COMMENT ON TABLE contact_verifications IS 'One-time codes proving a new administrator''s email and mobile number, sent from Manage Users.';

-- Reversal (manual, only if needed):
--   DROP TABLE contact_verifications;
--   ALTER TABLE users DROP COLUMN created_by;
--   ALTER TABLE audit_logs DROP COLUMN user_position_snapshot;
