-- The borrower signs a loan application typed into the app (admin New Loan,
-- member Apply Loan) on the "Borrower Signature" line, as on page 2 of the
-- printed Loan Application Form (Agri). The signature is kept with the
-- application and the loan it becomes: { path, fileName, mimeType, size, signedOn }.
-- Scanned paper forms carry the signature on the scan itself.
ALTER TABLE loan_requests ADD COLUMN IF NOT EXISTS borrower_signature JSONB;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS borrower_signature JSONB;

COMMENT ON COLUMN loan_requests.borrower_signature IS
  'The borrower''s signature drawn or uploaded on the application form (stored file and the date signed).';
COMMENT ON COLUMN loans.borrower_signature IS
  'The borrower''s signature from the application, or entered with the loan.';
