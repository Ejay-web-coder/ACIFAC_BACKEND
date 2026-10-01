-- A scanned loan application form is saved only with two valid IDs, each a
-- picture of the front and back of the ID with three specimen signatures: the
-- borrower's and the co-maker's. AI reads both and checks them against the
-- borrower and the co-maker named on the form. The borrower's ID is kept in the
-- id_document_* columns (like a membership applicant's); the co-maker's here.
ALTER TABLE document_scans
  ADD COLUMN IF NOT EXISTS co_maker_id_path TEXT,
  ADD COLUMN IF NOT EXISTS co_maker_id_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS co_maker_id_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS co_maker_id_size BIGINT,
  ADD COLUMN IF NOT EXISTS co_maker_id_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS co_maker_id_check JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE document_scans DROP CONSTRAINT IF EXISTS document_scans_co_maker_id_source_check;
ALTER TABLE document_scans
  ADD CONSTRAINT document_scans_co_maker_id_source_check CHECK (co_maker_id_source IS NULL OR co_maker_id_source IN ('upload', 'camera'));

COMMENT ON COLUMN document_scans.id_document_path IS
  'Valid ID submitted with the scanned form: the membership applicant''s, or the loan borrower''s.';
COMMENT ON COLUMN document_scans.id_document_source IS
  'How the ID was submitted: upload = a file of the back-to-back copy with three specimen signatures; camera = taken with the camera (for a membership form, the ID card itself; for a loan form, the signed copy).';
COMMENT ON COLUMN document_scans.co_maker_id_path IS
  'The co-maker''s valid ID submitted with a scanned loan form: the front and back of the ID with three specimen signatures.';
COMMENT ON COLUMN document_scans.co_maker_id_check IS
  'AI reading of the co-maker''s ID: ID type and number, name, birthday, address, sides visible, specimen signatures counted, screen, issues.';
