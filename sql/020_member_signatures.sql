-- Three specimen signatures taken with the Add Member form, as stored file
-- references (the same kind of reference as id_document_path). Members added
-- before this, by import or from an OCR scan have none.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS signature_paths TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN members.signature_paths IS 'Stored file references of the member''s specimen signatures (up to three), in the order they were signed.';
