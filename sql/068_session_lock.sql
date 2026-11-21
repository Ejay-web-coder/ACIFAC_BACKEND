-- Locked sessions (November 2026). A session idle for 20 minutes is no longer
-- ended: it is locked. While it is locked every request is refused (401
-- SESSION_LOCKED) and the cookie is kept; the person chooses "Stay logged in"
-- and enters their password (POST /api/auth/unlock), and the session goes on
-- where it was. Wrong passwords there count toward the sign-in lockout (3 in a
-- row lock the account for 20 minutes). A locked session still ends at its
-- normal 8-hour expiry, at logout, or when the password is changed. Kadiwa
-- vendor sessions are never locked.
--
-- locked_at: when the session became locked (last activity + 20 minutes),
-- written the first time the server sees it; NULL while it is in use, and set
-- back to NULL when it is unlocked.
--
-- Additive only: no existing record changes. Reversal (manual):
--   ALTER TABLE sessions DROP COLUMN locked_at;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

COMMENT ON COLUMN sessions.locked_at IS
  'Current. When the session was locked for inactivity (last_activity_at + 20 minutes), recorded the first time the server saw it; NULL while in use. A locked session refuses every request until POST /api/auth/unlock with the password. Never set for Kadiwa vendors.';
