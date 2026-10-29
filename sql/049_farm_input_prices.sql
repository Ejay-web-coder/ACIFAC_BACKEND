-- The office's price list of farm inputs for in-kind loans. Each product falls
-- under one of the six rows of the loan form's in-kind table (category), with
-- its unit and unit price. The office adds products and changes prices; a
-- product no longer sold is hidden (active = false), not deleted, so the
-- applications that named it keep their wording. A loan keeps the price it was
-- applied for (in_kind_items), whatever the list says later.
CREATE TABLE IF NOT EXISTS farm_input_prices (
  id SERIAL PRIMARY KEY,
  category VARCHAR(20) NOT NULL CHECK (category IN ('fertilizer', 'pesticides', 'herbicides', 'insecticides', 'seeds', 'plantChemicals')),
  name VARCHAR(500) NOT NULL CHECK (btrim(name) <> ''),
  unit VARCHAR(50) NOT NULL CHECK (btrim(unit) <> ''),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One product of a name and unit per category (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_farm_input_prices_product ON farm_input_prices (category, lower(btrim(name)), lower(btrim(unit)));

COMMENT ON TABLE farm_input_prices IS 'Farm inputs for in-kind loans: category (a row of the loan form''s in-kind table), product, unit and unit price, kept by the office.';

ALTER TABLE farm_input_prices ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE farm_input_prices FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE farm_input_prices_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- Reversal (manual, only if needed):
--   DROP TABLE farm_input_prices;
