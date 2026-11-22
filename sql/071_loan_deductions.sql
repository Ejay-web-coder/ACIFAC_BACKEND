-- Deductions from the loan proceeds (November 2026), under the loan policy
-- (Polisiya sa Pagpapautang, ALERT-ARBOs, rules 10 to 12; see sql/060). Every
-- loan released from now on records what was taken from its proceeds:
--   savings_deducted             PHP 500 for a loan of PHP 50,000 or less, PHP 1,000 above
--                                (a savings deposit, savings_deduction_id)
--   capital_build_up             2% of the loan amount: share capital as far as the 10% share
--                                capital limit allows (capital_build_up_contribution_id); the
--                                part over it, capital_build_up_to_savings, is a savings
--                                deposit (capital_build_up_savings_id)
--   pcic_insurance               PHP 50 PCIC life insurance
--   cash_released                the cash the borrower received: the loan's cash part less what
--                                a restructured loan still owed and these deductions
--   paid_at_release              what that cash could not cover (an in-kind loan has none),
--                                paid by the borrower at the office when the loan was released
-- The 2-hectare limit of a member's first year of loans (rule 2) needs no column:
-- it counts from the member's first loan (loans.date_approved).
--
-- Additive only: loans released before have NULL in all of them, and no
-- existing record changes. Reversal (manual):
--   ALTER TABLE loans DROP COLUMN savings_deducted, DROP COLUMN capital_build_up,
--     DROP COLUMN capital_build_up_to_savings, DROP COLUMN pcic_insurance, DROP COLUMN cash_released,
--     DROP COLUMN paid_at_release, DROP COLUMN savings_deduction_id,
--     DROP COLUMN capital_build_up_contribution_id, DROP COLUMN capital_build_up_savings_id;
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS savings_deducted NUMERIC(12, 2) CHECK (savings_deducted >= 0),
  ADD COLUMN IF NOT EXISTS capital_build_up NUMERIC(12, 2) CHECK (capital_build_up >= 0),
  ADD COLUMN IF NOT EXISTS capital_build_up_to_savings NUMERIC(12, 2) CHECK (capital_build_up_to_savings >= 0),
  ADD COLUMN IF NOT EXISTS pcic_insurance NUMERIC(12, 2) CHECK (pcic_insurance >= 0),
  ADD COLUMN IF NOT EXISTS cash_released NUMERIC(12, 2) CHECK (cash_released >= 0),
  ADD COLUMN IF NOT EXISTS paid_at_release NUMERIC(12, 2) CHECK (paid_at_release >= 0),
  ADD COLUMN IF NOT EXISTS savings_deduction_id INTEGER REFERENCES savings_transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capital_build_up_contribution_id INTEGER REFERENCES share_contributions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capital_build_up_savings_id INTEGER REFERENCES savings_transactions(id) ON DELETE SET NULL;

COMMENT ON COLUMN loans.savings_deducted IS
  'Current. Savings taken from the proceeds at release: PHP 500 for a loan of PHP 50,000 or less, PHP 1,000 above (loan policy rule 10); the deposit is savings_deduction_id. NULL for loans released before November 2026.';
COMMENT ON COLUMN loans.capital_build_up IS
  'Current. The 2% Capital Build-Up of the loan amount taken from the proceeds (rule 11): share capital (capital_build_up_contribution_id) as far as the 10% share capital limit allows, the rest (capital_build_up_to_savings) a savings deposit (capital_build_up_savings_id).';
COMMENT ON COLUMN loans.capital_build_up_to_savings IS
  'Current. The part of capital_build_up over the member''s 10% share capital limit, deposited to savings instead; 0 when all of it went to share capital.';
COMMENT ON COLUMN loans.pcic_insurance IS
  'Current. The PCIC life insurance taken from the proceeds, PHP 50 (rule 12).';
COMMENT ON COLUMN loans.cash_released IS
  'Current. The cash the borrower received: the loan''s cash part less what a restructured loan still owed and the deductions (never below 0).';
COMMENT ON COLUMN loans.paid_at_release IS
  'Current. The deductions the cash part could not cover (all of them for an in-kind loan), paid by the borrower at the office at release.';
