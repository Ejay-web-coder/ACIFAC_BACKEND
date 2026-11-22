-- Other income of the cooperative (November 2026): money that comes in from
-- outside its modules, such as donations, grants and subsidies, bank interest
-- or rent of the hall, recorded by the office. With the membership fees on the
-- members' forms and the absence fines and transfer fees collected under Dues,
-- it is "Others" in the Dashboard's Net Income and Capital (services/netIncome.js).
-- An entry recorded by mistake is deleted; the audit log keeps what it was.
--
-- Additive only. Reversal (manual; removes every entry):
--   DROP TABLE other_income;
CREATE TABLE IF NOT EXISTS other_income (
  id SERIAL PRIMARY KEY,
  received_on DATE NOT NULL,
  source VARCHAR(200) NOT NULL CHECK (btrim(source) <> ''),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reference_number VARCHAR(100),
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_other_income_received ON other_income(received_on);

COMMENT ON TABLE other_income IS
  'Current. Money the cooperative received from outside its modules (donations, grants, bank interest, rent, ...), recorded by the office; counted in "Others" of the Dashboard''s Net Income and Capital.';

-- Live updates (administrators only) and row level security, as for every other table (see 012).
DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_acifac_emit_change ON other_income;
  CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON other_income FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('');
  ALTER TABLE other_income ENABLE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE other_income FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE other_income_id_seq FROM anon, authenticated;
  END IF;
END $$;
