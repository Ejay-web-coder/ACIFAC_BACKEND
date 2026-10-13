-- Loan restructuring. A loan the borrower cannot keep up with is given a new
-- schedule for its remaining balance, in place: it keeps its loan number and
-- payments. Each restructuring is a row here; the installments still open at
-- that moment point to it (superseded_by) and stop counting as due, and the new
-- installments are added after them. An installment already past due when it
-- was replaced stays in the member's credit history as a late payment.
-- Additive only.
CREATE TABLE IF NOT EXISTS loan_restructurings (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  restructured_on DATE NOT NULL,
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  -- The balance carried into the new schedule, and its principal and interest.
  balance_carried NUMERIC(14, 2) NOT NULL CHECK (balance_carried > 0),
  principal_carried NUMERIC(14, 2) NOT NULL CHECK (principal_carried >= 0),
  interest_carried NUMERIC(14, 2) NOT NULL CHECK (interest_carried >= 0),
  -- Of that balance, what was already past due, and in how many installments.
  overdue_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (overdue_amount >= 0),
  overdue_installments INTEGER NOT NULL DEFAULT 0 CHECK (overdue_installments >= 0),
  -- Interest charged on the carried balance (flat, once), and the new schedule.
  interest_rate NUMERIC(5, 2) NOT NULL CHECK (interest_rate >= 0),
  added_interest NUMERIC(14, 2) NOT NULL CHECK (added_interest >= 0),
  new_term INTEGER NOT NULL CHECK (new_term BETWEEN 1 AND 60),
  new_monthly_payment NUMERIC(14, 2) NOT NULL CHECK (new_monthly_payment > 0),
  previous_due_date DATE NOT NULL,
  new_due_date DATE NOT NULL,
  first_installment_number INTEGER NOT NULL CHECK (first_installment_number > 1),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loan_restructuring_balance_parts CHECK (principal_carried + interest_carried = balance_carried)
);
CREATE INDEX IF NOT EXISTS idx_loan_restructurings_loan ON loan_restructurings(loan_id, restructured_on);

ALTER TABLE loan_installments
  ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES loan_restructurings(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_loan_installments_superseded ON loan_installments(superseded_by) WHERE superseded_by IS NOT NULL;

COMMENT ON TABLE loan_restructurings IS
  'Each time a loan was restructured: the balance carried into a new schedule (principal and interest), what of it was overdue, the interest added, the new term and monthly payment, and why.';
COMMENT ON COLUMN loan_installments.superseded_by IS
  'Set when a restructuring replaced this installment: it is no longer due. One past due before the restructuring still counts as a late payment in the credit history.';

ALTER TABLE loan_restructurings ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE loan_restructurings FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE loan_restructurings_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- Reversal (manual, only if needed, and only before any loan is restructured):
--   ALTER TABLE loan_installments DROP COLUMN superseded_by;
--   DROP TABLE loan_restructurings;
