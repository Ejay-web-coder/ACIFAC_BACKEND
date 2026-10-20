-- The full name of whoever did an action, kept with the log entry as it was at
-- that moment (user_name_snapshot keeps the username): an administrator's
-- profile name, a member's name from their member record. Entries written
-- before this column existed are left as they are and shown with the person's
-- current name (see listAuditLogs).
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_full_name_snapshot VARCHAR(200);

COMMENT ON COLUMN audit_logs.user_full_name_snapshot IS
  'Full name of the user at the time of the action: the member record''s name for a member, else the account''s full name. NULL for system actions and for entries older than this column.';

-- Reversal (manual, only if needed):
--   ALTER TABLE audit_logs DROP COLUMN user_full_name_snapshot;
