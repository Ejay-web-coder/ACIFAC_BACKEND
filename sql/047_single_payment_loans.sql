-- Loans are now for 6 months, repaid in one payment of the whole amount
-- (principal and interest) by the due date, 6 months after approval.
--
-- loans.repayment: 'single' = one installment for the whole amount, paid in
-- full at once; 'monthly' = equal monthly installments. The loans made before
-- this change keep their monthly schedules; every loan made from now on is single.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS repayment VARCHAR(10) NOT NULL DEFAULT 'monthly';
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_repayment_check;
ALTER TABLE loans ADD CONSTRAINT loans_repayment_check CHECK (repayment IN ('monthly', 'single'));
ALTER TABLE loans ALTER COLUMN repayment SET DEFAULT 'single';

COMMENT ON COLUMN loans.repayment IS 'single: one payment of the whole amount by the due date (loans from October 2026 on); monthly: equal monthly installments (earlier loans).';

-- Reversal (manual, only if needed):
--   ALTER TABLE loans DROP COLUMN repayment;
