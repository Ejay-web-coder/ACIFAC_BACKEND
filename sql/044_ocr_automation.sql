-- OCR Scanner automation.
--
-- A scan the AI could not read (busy, unreachable) is queued and read again
-- by itself: retry_count tries so far, next_retry_at when the next one is due
-- (NULL = not queued). uploaded_by is the admin the background reading acts
-- for, so its audit entries and records carry their name.
--
-- The form is read twice, independently; cross_check keeps both readings so
-- verification can flag the fields they disagree on:
-- { "firstType", "documentType", "first": {...}, "second": {...}, "at" } or { "error", "at" }.
--
-- confidence is now the share of verification checks passed (0-100), worked
-- out by the system; ai_confidence keeps the confidence the AI reported.
--
-- A form saved automatically can be undone by an admin for 48 hours:
-- undone_at / undone_by / undone_record_id record that it was.
ALTER TABLE document_scans
  ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cross_check JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS undone_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undone_record_id VARCHAR(60);

UPDATE document_scans SET ai_confidence = confidence WHERE ai_confidence IS NULL AND confidence IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_scans_next_retry ON document_scans(next_retry_at) WHERE next_retry_at IS NOT NULL;

COMMENT ON COLUMN document_scans.next_retry_at IS 'When the AI reading (or the second, cross-check reading) is tried again by itself; NULL when not queued.';
COMMENT ON COLUMN document_scans.cross_check IS 'Two independent AI readings of the form, compared field by field during verification.';
COMMENT ON COLUMN document_scans.confidence IS 'Share of verification checks passed (0-100), computed by the system.';
COMMENT ON COLUMN document_scans.ai_confidence IS 'Reading confidence reported by the AI (used only to accept the document type).';

-- Reversal (manual, only if needed):
--   ALTER TABLE document_scans DROP COLUMN uploaded_by, DROP COLUMN retry_count, DROP COLUMN next_retry_at, DROP COLUMN cross_check,
--     DROP COLUMN ai_confidence, DROP COLUMN undone_at, DROP COLUMN undone_by, DROP COLUMN undone_record_id;
