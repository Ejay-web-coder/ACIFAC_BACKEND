-- Payments for machines rented by the day (machinery_operations), as the
-- service payments are kept: every collection is a row, a rental's amount paid
-- is their sum and its balance is the rental fee less that. A rental also
-- recorded as a service is paid under the service, never here.
-- The income does not change: net income and the patronage refund still count
-- a rental's fee from the day it starts.
CREATE TABLE IF NOT EXISTS machinery_rental_payments (
  id SERIAL PRIMARY KEY,
  operation_id INTEGER NOT NULL REFERENCES machinery_operations(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_machinery_rental_payments_operation ON machinery_rental_payments(operation_id);
CREATE INDEX IF NOT EXISTS idx_machinery_rental_payments_date ON machinery_rental_payments(payment_date);

COMMENT ON TABLE machinery_rental_payments IS
  'Current. One row per payment received for a day rental (machinery_operations). The amount paid of a rental is their sum and may not exceed its rental fee (checked by the API under a row lock). Voiding a payment deletes its row; the audit log keeps it.';

-- Live updates and row level security, as for every other table (see 012).
DROP TRIGGER IF EXISTS trg_acifac_emit_change ON machinery_rental_payments;
CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON machinery_rental_payments
  FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('');
ALTER TABLE machinery_rental_payments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE machinery_rental_payments FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE machinery_rental_payments_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- Reversal (manual, only if needed; removes every rental payment):
--   DROP TABLE machinery_rental_payments;
