-- A scanned membership form needs the applicant's 2x2 picture. When the AI
-- cannot recognise the picture in the form's photo box (empty, or the face
-- cannot be made out), the admin uploads one. It is kept on the scan with the
-- AI's check of it and becomes the new member's photo when the form is saved.
ALTER TABLE document_scans
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS photo_check JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN document_scans.photo_path IS
  'The applicant''s 2x2 picture uploaded because the one on the scanned membership form could not be recognised.';
COMMENT ON COLUMN document_scans.photo_check IS
  'AI check of the uploaded 2x2 picture: one person, face clearly visible, screen or edited image, issues.';
