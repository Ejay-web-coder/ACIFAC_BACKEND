-- Loan applications typed into the app (admin New Loan, member Apply Loan)
-- need the borrower's and the co-maker's valid IDs, each a back-to-back copy
-- with three specimen signatures, like a scanned loan form.
--
-- AI reads each ID as soon as it is picked in the form. The reading is kept
-- here for a day with the file's SHA-256, so that when the form is submitted
-- with the same file the server uses that reading instead of asking AI again.
CREATE TABLE IF NOT EXISTS loan_id_readings (
  id BIGSERIAL PRIMARY KEY,
  holder VARCHAR(20) NOT NULL CHECK (holder IN ('borrower', 'coMaker')),
  source VARCHAR(20) NOT NULL CHECK (source IN ('upload', 'camera')),
  file_sha256 CHAR(64) NOT NULL,
  reading JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loan_id_readings_created_at ON loan_id_readings (created_at);

-- The IDs submitted with an application, kept with the application and the
-- loan it becomes: { "borrower": { path, fileName, mimeType, size, source,
-- reading, checks }, "coMaker": { ... } }. A scanned loan form's IDs point at
-- the files kept with the scan (scanId).
ALTER TABLE loan_requests ADD COLUMN IF NOT EXISTS id_documents JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS id_documents JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON TABLE loan_id_readings IS
  'AI readings of valid IDs picked in the loan application form, kept for a day so the submitted file is not read twice.';
COMMENT ON COLUMN loan_requests.id_documents IS
  'The borrower''s and co-maker''s valid IDs (stored file, AI reading, checks against the borrower and co-maker).';
COMMENT ON COLUMN loans.id_documents IS
  'The borrower''s and co-maker''s valid IDs, from the application or entered with the loan.';
