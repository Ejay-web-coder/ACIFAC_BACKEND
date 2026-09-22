CREATE TABLE IF NOT EXISTS document_scans (
  id BIGSERIAL PRIMARY KEY,
  original_file_name VARCHAR(255) NOT NULL,
  stored_file_path TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL,
  file_sha256 CHAR(64) NOT NULL UNIQUE,
  detected_document_type VARCHAR(100) NOT NULL DEFAULT 'Document Type Not Recognized',
  confidence NUMERIC(5, 2),
  ocr_text TEXT NOT NULL DEFAULT '',
  extracted_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_status VARCHAR(30) NOT NULL DEFAULT 'completed',
  processing_error TEXT,
  review_status VARCHAR(30) NOT NULL DEFAULT 'needs_review',
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_scans_review_status_check CHECK (review_status IN ('needs_review', 'reviewed', 'rejected')),
  CONSTRAINT document_scans_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100))
);

ALTER TABLE document_scans
  ADD COLUMN IF NOT EXISTS processing_status VARCHAR(30) NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS processing_error TEXT;

ALTER TABLE document_scans
  DROP CONSTRAINT IF EXISTS document_scans_processing_status_check;

ALTER TABLE document_scans
  ADD CONSTRAINT document_scans_processing_status_check CHECK (processing_status IN ('completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_document_scans_created_at ON document_scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_scans_review_status ON document_scans(review_status);