-- Savings withdrawals. A withdrawal is a row in the same ledger as deposits,
-- with transaction_type 'withdrawal' and a positive amount; a member's savings
-- balance is the deposits minus the withdrawals (src/services/savingsLedger.js).
-- A withdrawal is never more than the balance on its date, so the running
-- balance never goes below zero.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'savings_transactions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%transaction_type%'
  LOOP
    EXECUTE format('ALTER TABLE savings_transactions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE savings_transactions
  ADD CONSTRAINT savings_transactions_transaction_type_check CHECK (transaction_type IN ('deposit', 'withdrawal'));

COMMENT ON COLUMN savings_transactions.transaction_type IS
  'deposit adds the amount to the member''s savings; withdrawal takes it out. The amount is always positive.';
