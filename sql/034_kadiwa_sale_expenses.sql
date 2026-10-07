-- The expenses of a Kadiwa sale, one line each (Transportation ₱150, Plastic
-- bags ₱40 ...), as entered on the New Sale form. The sale's total_expenses is
-- their sum. Sales saved before have their total only.
CREATE TABLE IF NOT EXISTS kadiwa_sale_expenses (
  id SERIAL PRIMARY KEY,
  sale_id VARCHAR(30) NOT NULL REFERENCES kadiwa_sales(id) ON DELETE CASCADE,
  line_no SMALLINT NOT NULL CHECK (line_no > 0),
  description VARCHAR(120) NOT NULL CHECK (btrim(description) <> ''),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, line_no)
);
COMMENT ON TABLE kadiwa_sale_expenses IS 'One expense of a Kadiwa sale: what it was for and the amount. kadiwa_sales.total_expenses is the sum of its lines (older sales have the total only).';

ALTER TABLE kadiwa_sale_expenses ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE kadiwa_sale_expenses FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE kadiwa_sale_expenses_id_seq FROM anon, authenticated;
  END IF;
END $$;
