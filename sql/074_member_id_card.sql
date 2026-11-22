-- Member ID cards with a QR code (November 2026).
--   members.id_token       each member's random code: 32 hexadecimal
--                          characters. The QR on the card holds only
--                          "ACIFAC:" and this code, never a name or phone
--                          number, so a lost card reveals nothing. Reissuing a
--                          card gives the member a new code, and the old card
--                          stops working.
--   members.id_issued_at   when the current code was issued.
--   activity_attendance.source  may also be 'scan': the member checked in at
--                          the door by showing their member ID.
-- Every member, existing or new, gets a code of their own: the column default
-- is evaluated for each row (gen_random_uuid() is built into PostgreSQL 13+).
--
-- Additive only. Reversal (manual; every printed card stops working):
--   ALTER TABLE members DROP COLUMN id_token, DROP COLUMN id_issued_at;
--   ALTER TABLE activity_attendance DROP CONSTRAINT activity_attendance_source_check;
--   ALTER TABLE activity_attendance ADD CONSTRAINT activity_attendance_source_check CHECK (source IN ('office', 'finalization'));
--   (after changing any 'scan' rows to 'office')

ALTER TABLE members ADD COLUMN IF NOT EXISTS id_token VARCHAR(32) NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE members ADD COLUMN IF NOT EXISTS id_issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_id_token_format;
ALTER TABLE members ADD CONSTRAINT members_id_token_format CHECK (id_token ~ '^[0-9a-f]{32}$');
-- One member per code; also how a scanned card is looked up.
CREATE UNIQUE INDEX IF NOT EXISTS members_id_token_key ON members(id_token);

COMMENT ON COLUMN members.id_token IS
  'Current. The random code in the QR of the member''s ID card ("ACIFAC:" + this code). Reissuing the card replaces it, so the old card stops working. Never shown in the audit log.';
COMMENT ON COLUMN members.id_issued_at IS
  'Current. When the member ID card code (id_token) was issued: the migration for members who joined before ID cards, else when the member was added or the card was last reissued.';

ALTER TABLE activity_attendance DROP CONSTRAINT IF EXISTS activity_attendance_source_check;
ALTER TABLE activity_attendance ADD CONSTRAINT activity_attendance_source_check CHECK (source IN ('office', 'finalization', 'scan'));
COMMENT ON COLUMN activity_attendance.source IS
  'office: marked by the office. finalization: the member was not marked and was recorded absent when the attendance was finalized. scan: the member checked in at the door by showing their member ID (present, or late after the start time).';
