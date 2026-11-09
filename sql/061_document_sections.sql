-- The About page has two lists of files: Legal Documents and Others (the
-- cooperative's other papers, such as the Articles of Cooperation, By-Laws,
-- resolutions, tax returns and audited financial statements, searchable by
-- title). Both are kept in legal_documents; section says which tab a file is
-- on. Files uploaded so far stay under Legal Documents. Additive only.
ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS section VARCHAR(20) NOT NULL DEFAULT 'legal';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_documents_section_check') THEN
    ALTER TABLE legal_documents ADD CONSTRAINT legal_documents_section_check CHECK (section IN ('legal', 'others'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_legal_documents_section ON legal_documents(section, name) WHERE deleted_at IS NULL;
