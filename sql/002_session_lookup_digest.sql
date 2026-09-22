ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS token_digest CHAR(64);

CREATE INDEX IF NOT EXISTS idx_sessions_token_digest
  ON sessions(token_digest)
  WHERE revoked_at IS NULL;
