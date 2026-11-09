-- The member's RSBSA Enrollment Client's Copy: a picture or scan the office
-- uploads or photographs in the member form, next to the RSBSA No. Optional.
-- Stored in the member documents bucket like the valid ID. Additive only.
ALTER TABLE members ADD COLUMN IF NOT EXISTS rsbsa_document_path TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS rsbsa_document_name VARCHAR(255);
ALTER TABLE members ADD COLUMN IF NOT EXISTS rsbsa_document_type VARCHAR(100);
ALTER TABLE members ADD COLUMN IF NOT EXISTS rsbsa_document_size INTEGER;
