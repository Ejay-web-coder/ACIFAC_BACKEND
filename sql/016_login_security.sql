-- Login security: failed sign-in lockouts, emailed password reset codes and
-- the 20-minute inactivity timeout. Additive only: no existing rows change
-- except that every current session gets last_activity_at = migration time,
-- so nobody is signed out by the deploy itself.

-- 1. Failed sign-in counters and temporary lockouts --------------------------
-- One row per account ('user:<id>'), per sign-in name that matches no account
-- ('name:<sha256 of the lower-cased name>', so unknown names lock exactly like
-- real ones and lockouts cannot reveal which accounts exist) and per client IP
-- ('ip:<address>'). Kept apart from users so a failed sign-in never touches
-- the users row (which would fire the live-update trigger for administrators).
CREATE TABLE IF NOT EXISTS login_throttles (
  throttle_key VARCHAR(120) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_throttles_user ON login_throttles(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_login_throttles_updated ON login_throttles(updated_at);

-- 2. Emailed 6-digit password reset codes -------------------------------------
-- password_reset_tokens keeps serving the single-use links used for account
-- setup and office resets. Codes need per-address rows (also for addresses
-- with no account, with user_id NULL and a code nobody knows, so every
-- response is identical), attempt counting and a verified step, so they get
-- their own table. Codes are stored only as bcrypt hashes; the reset grant
-- issued after verification is stored only as a SHA-256 digest.
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id BIGSERIAL PRIMARY KEY,
  email_digest CHAR(64) NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  verified_at TIMESTAMPTZ,
  grant_digest CHAR(64),
  grant_expires_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  invalidated_reason VARCHAR(30) CHECK (invalidated_reason IN ('USED', 'REPLACED', 'TOO_MANY_ATTEMPTS', 'PASSWORD_CHANGED')),
  ip_address VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_email ON password_reset_codes(email_digest, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_ip ON password_reset_codes(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user ON password_reset_codes(user_id) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_password_reset_codes_created ON password_reset_codes(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_codes_grant ON password_reset_codes(grant_digest) WHERE grant_digest IS NOT NULL;

-- 3. Session inactivity -------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 4. Same protection as every other table (see 012 section 4) -----------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['login_throttles', 'password_reset_codes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', tbl);
    END IF;
  END LOOP;
END $$;

-- Reversal (manual, only if needed):
--   DROP TABLE login_throttles; DROP TABLE password_reset_codes;
--   ALTER TABLE sessions DROP COLUMN last_activity_at;
