-- Sales of the bags of palay the cooperative earns from harvesting (November 2026).
-- Harvesting is charged in bags (machinery_services, unit per_100_bags: the fee
-- is fee_bags, valued at bag_value each). The cooperative keeps those bags and
-- sells them later at the price of the day, which changes from sale to sale, so
-- every sale keeps its own price per bag. amount = bags x price_per_bag,
-- rounded to centavos.
--
-- Bags the cooperative holds (Machinery > Bag Sales), all time:
--   received  harvest fees paid, in bags: amount_paid / bag_value per service
--   sold      the bags of these sales
--   on hand   received - sold (a sale may not take it below zero)
--
-- Additive only: no existing table or record changes. Reversal (manual; removes
-- every bag sale): DROP TABLE machinery_bag_sales;
CREATE TABLE IF NOT EXISTS machinery_bag_sales (
  id SERIAL PRIMARY KEY,
  sale_date DATE NOT NULL,
  bags NUMERIC(10, 2) NOT NULL CHECK (bags > 0),
  price_per_bag NUMERIC(12, 2) NOT NULL CHECK (price_per_bag > 0),
  amount NUMERIC(14, 2) GENERATED ALWAYS AS (ROUND(bags * price_per_bag, 2)) STORED,
  buyer VARCHAR(200) NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_machinery_bag_sales_date ON machinery_bag_sales(sale_date);

COMMENT ON TABLE machinery_bag_sales IS
  'Current. Sales of the bags of palay the cooperative earned as harvesting fees (machinery_services with unit per_100_bags). Each sale keeps its own price per bag because the price changes; amount = bags x price_per_bag. Bags on hand = harvest fees paid in bags (amount_paid / bag_value) - bags sold.';

-- Live updates and row level security, as for every other table (see 012).
DROP TRIGGER IF EXISTS trg_acifac_emit_change ON machinery_bag_sales;
CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON machinery_bag_sales
  FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('');
ALTER TABLE machinery_bag_sales ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE machinery_bag_sales FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE machinery_bag_sales_id_seq FROM anon, authenticated;
  END IF;
END $$;
