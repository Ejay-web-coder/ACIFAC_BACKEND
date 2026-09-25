-- OCR scans can now be captured with a camera as well as uploaded, are checked
-- for authenticity, and — once verified — are posted to the module they belong
-- to (members, loans, savings, machinery, Kadiwa sales).

ALTER TABLE document_scans
  ADD COLUMN IF NOT EXISTS capture_source VARCHAR(20) NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS authenticity JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS posted_module VARCHAR(40),
  ADD COLUMN IF NOT EXISTS posted_record_id VARCHAR(60),
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS posted_automatically BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE document_scans DROP CONSTRAINT IF EXISTS document_scans_capture_source_check;
ALTER TABLE document_scans
  ADD CONSTRAINT document_scans_capture_source_check CHECK (capture_source IN ('upload', 'camera'));

-- 'posted' = the document's data was saved to its module.
ALTER TABLE document_scans DROP CONSTRAINT IF EXISTS document_scans_review_status_check;
ALTER TABLE document_scans
  ADD CONSTRAINT document_scans_review_status_check CHECK (review_status IN ('needs_review', 'reviewed', 'rejected', 'posted'));

CREATE INDEX IF NOT EXISTS idx_document_scans_posted ON document_scans(posted_module, posted_record_id) WHERE posted_at IS NOT NULL;
