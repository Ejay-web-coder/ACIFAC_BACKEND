-- Add Member and Edit Member need the applicant's valid ID as a back-to-back
-- copy (front and back of the ID on one page) with three specimen signatures,
-- like a loan co-maker's. The form no longer has signatures drawn on screen.
--
-- AI reads the ID as soon as it is picked in the form. The reading is kept
-- here for a day with the file's SHA-256, so that when the member is saved
-- with the same file the server uses that reading instead of asking AI again.
CREATE TABLE IF NOT EXISTS member_id_readings (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(20) NOT NULL CHECK (source IN ('upload', 'camera')),
  file_sha256 CHAR(64) NOT NULL,
  reading JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_member_id_readings_created_at ON member_id_readings (created_at);

COMMENT ON TABLE member_id_readings IS
  'AI readings of applicants'' valid IDs picked in Add Member or Edit Member, kept for a day so the submitted file is not read twice.';
