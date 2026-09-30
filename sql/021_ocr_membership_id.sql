-- A scanned membership form is saved only with the applicant's valid ID: an
-- uploaded back-to-back copy (front and back of the ID on one page) with three
-- specimen signatures, or the ID card captured with the live camera. The ID and
-- the AI's reading of it are kept on the scan; when the form is saved the ID
-- becomes the new member's ID document.
ALTER TABLE document_scans
  ADD COLUMN IF NOT EXISTS id_document_path TEXT,
  ADD COLUMN IF NOT EXISTS id_document_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS id_document_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS id_document_size BIGINT,
  ADD COLUMN IF NOT EXISTS id_document_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS id_document_check JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE document_scans DROP CONSTRAINT IF EXISTS document_scans_id_document_source_check;
ALTER TABLE document_scans
  ADD CONSTRAINT document_scans_id_document_source_check CHECK (id_document_source IS NULL OR id_document_source IN ('upload', 'camera'));

COMMENT ON COLUMN document_scans.id_document_source IS
  'How the applicant''s ID was submitted: upload = a back-to-back copy with three specimen signatures; camera = the ID card captured with the live camera.';
COMMENT ON COLUMN document_scans.id_document_check IS
  'AI reading of the submitted ID: ID type and number, name, sides visible, specimen signatures counted, photocopy / screen, issues.';
