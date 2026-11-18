-- Late payment penalty (the loan policy): a loan is paid within its 6-month
-- term; after the due date there is a grace period of 5 days, and from then on
-- a penalty of PHP 100 is added for every day until the loan is paid in full.
--
-- Each loan keeps the penalty terms it was made with, as it keeps its interest
-- rate:
--   loans.penalty_per_day  pesos added for each day past the grace period
--   loans.grace_days       days after the due date before the penalty starts
-- The 6-month single-payment loans (October 2026 on) take the policy; the
-- loans repaid monthly (before) keep their terms, without a penalty. Every loan
-- made from now on takes the policy (the column defaults).
ALTER TABLE loans ADD COLUMN IF NOT EXISTS penalty_per_day NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS grace_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_penalty_terms_check;
ALTER TABLE loans ADD CONSTRAINT loans_penalty_terms_check CHECK (penalty_per_day >= 0 AND grace_days BETWEEN 0 AND 365);
UPDATE loans SET penalty_per_day = 100, grace_days = 5 WHERE repayment = 'single';
ALTER TABLE loans ALTER COLUMN penalty_per_day SET DEFAULT 100;
ALTER TABLE loans ALTER COLUMN grace_days SET DEFAULT 5;

-- The part of a payment that paid the penalty. A payment pays the penalty due
-- on its date first, then interest, then principal; amount = penalty_paid +
-- interest_paid + principal_paid, and remaining_balance is principal and
-- interest still owed after it.
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS penalty_paid NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE loan_payments DROP CONSTRAINT IF EXISTS loan_payments_penalty_paid_check;
ALTER TABLE loan_payments ADD CONSTRAINT loan_payments_penalty_paid_check CHECK (penalty_paid >= 0 AND penalty_paid <= amount);

-- A loan restructured into a new one: the penalty owed on it is deducted from
-- the new loan's proceeds along with the balance.
ALTER TABLE loan_restructurings ADD COLUMN IF NOT EXISTS penalty_carried NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE loan_restructurings DROP CONSTRAINT IF EXISTS loan_restructurings_penalty_carried_check;
ALTER TABLE loan_restructurings ADD CONSTRAINT loan_restructurings_penalty_carried_check CHECK (penalty_carried >= 0);
ALTER TABLE loan_restructurings DROP CONSTRAINT IF EXISTS loan_restructurings_renewal_figures;
ALTER TABLE loan_restructurings ADD CONSTRAINT loan_restructurings_renewal_figures CHECK (
  kind <> 'renewal' OR (amount_paid_before IS NOT NULL AND total_before IS NOT NULL AND new_loan_amount IS NOT NULL
                        AND net_proceeds IS NOT NULL AND net_proceeds = new_loan_amount - balance_carried - penalty_carried)
);

COMMENT ON COLUMN loans.penalty_per_day IS 'Late penalty in pesos for each day past the grace period, until the loan is paid in full (PHP 100 for loans from October 2026; 0 for the earlier monthly loans).';
COMMENT ON COLUMN loans.grace_days IS 'Days after the due date before the late penalty starts (5).';
COMMENT ON COLUMN loan_payments.penalty_paid IS 'The part of the payment that paid the late penalty (paid before interest and principal).';
COMMENT ON COLUMN loan_restructurings.penalty_carried IS 'Late penalty owed on the loan when it was renewed, deducted from the new loan with the balance.';

-- Reversal (manual, only if needed, and only before any penalty is paid):
--   ALTER TABLE loan_restructurings DROP CONSTRAINT loan_restructurings_renewal_figures;
--   ALTER TABLE loan_restructurings ADD CONSTRAINT loan_restructurings_renewal_figures CHECK (kind <> 'renewal' OR (amount_paid_before IS NOT NULL
--     AND total_before IS NOT NULL AND new_loan_amount IS NOT NULL AND net_proceeds IS NOT NULL AND net_proceeds = new_loan_amount - balance_carried));
--   ALTER TABLE loan_restructurings DROP COLUMN penalty_carried;
--   ALTER TABLE loan_payments DROP COLUMN penalty_paid;
--   ALTER TABLE loans DROP COLUMN penalty_per_day, DROP COLUMN grace_days;
