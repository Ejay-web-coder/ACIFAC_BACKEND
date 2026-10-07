-- Kadiwa sales are recorded like the Kadiwa ng Pangulo daily sales form: the
-- seller, the date of the sales, and each good sold (PORK, EGG, GROCERIES,
-- TALONG ...) with its unit, price, quantity and total amount. The 15-day and
-- monthly reports add these lines up per good.

-- The day the goods were sold, which the form gives; it can be earlier than
-- the day the form is typed in. Existing sales keep the day they were saved.
ALTER TABLE kadiwa_sales ADD COLUMN IF NOT EXISTS sale_date DATE;
UPDATE kadiwa_sales SET sale_date = (created_at AT TIME ZONE 'Asia/Manila')::date WHERE sale_date IS NULL;
ALTER TABLE kadiwa_sales ALTER COLUMN sale_date SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::date);
ALTER TABLE kadiwa_sales ALTER COLUMN sale_date SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kadiwa_sales_sale_date ON kadiwa_sales(sale_date DESC, id DESC);
COMMENT ON COLUMN kadiwa_sales.sale_date IS 'Date of the sales on the daily form. Reports, net income and analytics use it.';
COMMENT ON COLUMN kadiwa_sales.encoder_name IS 'Seller Name on the daily sales form.';

CREATE TABLE IF NOT EXISTS kadiwa_sale_goods (
  id SERIAL PRIMARY KEY,
  sale_id VARCHAR(30) NOT NULL REFERENCES kadiwa_sales(id) ON DELETE CASCADE,
  line_no SMALLINT NOT NULL CHECK (line_no > 0),
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(20),
  category VARCHAR(30) NOT NULL CHECK (category IN ('Groceries', 'Vegetables', 'Meat', 'Other')),
  price NUMERIC(12, 2) CHECK (price IS NULL OR price >= 0),
  quantity NUMERIC(14, 4) CHECK (quantity IS NULL OR quantity > 0),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_kadiwa_sale_goods_name ON kadiwa_sale_goods(name);
COMMENT ON TABLE kadiwa_sale_goods IS 'One line of the daily sales form. The amount is counted in the sale''s groceries, vegetables or meat total by category (Other with groceries).';
COMMENT ON COLUMN kadiwa_sale_goods.quantity IS 'Quantity sold in the unit; when only the amount was written it is amount / price, as on the 15-day report.';

ALTER TABLE kadiwa_sale_goods ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE kadiwa_sale_goods FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE kadiwa_sale_goods_id_seq FROM anon, authenticated;
  END IF;
END $$;
