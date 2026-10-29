-- Restructuring is now a renewal. A borrower who has paid at least 80% of a
-- loan (principal and interest) may take a new loan; what is still owed on the
-- old one (at most 20%) is deducted from the new loan's proceeds and recorded
-- as the old loan's last payment, which closes it.
--
-- loan_restructurings.kind: 'renewal' for these; 'reschedule' for the earlier
-- restructurings that gave a loan a new schedule in place (they keep their
-- figures). A renewal has no new schedule on the old loan, so the schedule
-- columns are empty for it.
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'reschedule';
ALTER TABLE loan_restructurings DROP CONSTRAINT IF EXISTS loan_restructurings_kind_check;
ALTER TABLE loan_restructurings ADD CONSTRAINT loan_restructurings_kind_check CHECK (kind IN ('reschedule', 'renewal'));

-- What had been paid on the old loan, of its total, when it was renewed.
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS amount_paid_before NUMERIC(14, 2) CHECK (amount_paid_before >= 0);
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS total_before NUMERIC(14, 2) CHECK (total_before > 0);
-- The new loan, its amount, and what the borrower received after the deduction
-- (balance_carried is the deduction).
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS new_loan_id INTEGER REFERENCES loans(id) ON DELETE SET NULL;
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS new_loan_amount NUMERIC(14, 2) CHECK (new_loan_amount > 0);
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS net_proceeds NUMERIC(14, 2) CHECK (net_proceeds >= 0);
-- The old loan's payment that the deduction recorded.
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS payment_id INTEGER REFERENCES loan_payments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_loan_restructurings_new_loan ON loan_restructurings(new_loan_id) WHERE new_loan_id IS NOT NULL;

ALTER TABLE loan_restructurings ALTER COLUMN added_interest DROP NOT NULL;
ALTER TABLE loan_restructurings ALTER COLUMN new_term DROP NOT NULL;
ALTER TABLE loan_restructurings ALTER COLUMN new_monthly_payment DROP NOT NULL;
ALTER TABLE loan_restructurings ALTER COLUMN first_installment_number DROP NOT NULL;

ALTER TABLE loan_restructurings DROP CONSTRAINT IF EXISTS loan_restructurings_renewal_figures;
ALTER TABLE loan_restructurings ADD CONSTRAINT loan_restructurings_renewal_figures CHECK (
  kind <> 'renewal' OR (amount_paid_before IS NOT NULL AND total_before IS NOT NULL AND new_loan_amount IS NOT NULL
                        AND net_proceeds IS NOT NULL AND net_proceeds = new_loan_amount - balance_carried)
);

COMMENT ON COLUMN loan_restructurings.kind IS
  'renewal: after 80% was paid, a new loan whose proceeds paid off this balance (from October 2026); reschedule: the balance was given a new schedule on the same loan (earlier).';

-- Reversal (manual, only if needed, and only before any loan is renewed):
--   ALTER TABLE loan_restructurings DROP CONSTRAINT loan_restructurings_renewal_figures;
--   ALTER TABLE loan_restructurings DROP COLUMN kind, DROP COLUMN amount_paid_before, DROP COLUMN total_before,
--     DROP COLUMN new_loan_id, DROP COLUMN new_loan_amount, DROP COLUMN net_proceeds, DROP COLUMN payment_id;
--   then SET NOT NULL again on added_interest, new_term, new_monthly_payment, first_installment_number.
