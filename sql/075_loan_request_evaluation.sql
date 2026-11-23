-- "For Evaluation" on a loan application (November 2026). When the office
-- ticks For Evaluation in VII. For Office Use Only, it writes what is being
-- evaluated (e.g. "Checking the farm area with the barangay"); the
-- application stays pending until it is approved or disapproved. Saving it
-- again replaces the note. The note is for the office only: members are not
-- told and never receive it (it is not in /api/members/me).
--
-- Additive only: no existing application changes (all have no note, NULL).
-- Reversal (manual):
--   ALTER TABLE loan_requests DROP COLUMN evaluation_notes, DROP COLUMN evaluated_at, DROP COLUMN evaluated_by;
ALTER TABLE loan_requests
  ADD COLUMN IF NOT EXISTS evaluation_notes TEXT,
  ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evaluated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN loan_requests.evaluation_notes IS
  'Current. What the office is evaluating on the application (For Evaluation, office only); the latest note replaces the one before. NULL when it was never kept for evaluation.';
COMMENT ON COLUMN loan_requests.evaluated_at IS
  'Current. When the evaluation note was last saved.';
COMMENT ON COLUMN loan_requests.evaluated_by IS
  'Current. The administrator who last saved the evaluation note.';
