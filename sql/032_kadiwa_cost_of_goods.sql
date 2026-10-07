-- Store products sold from the inventory carry their cost price (puhunan), so
-- each sale knows its cost of goods and its net income:
--   net_sales = goods sold (groceries + vegetables + meat) - expenses - cost of goods
-- The cost price is copied onto each sold item at the time of the sale, so a
-- later change of the product's cost does not change past sales. Sales saved
-- before this have no cost of goods (0).
ALTER TABLE kadiwa_sale_items
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12, 2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS line_cost NUMERIC(14, 2) CHECK (line_cost IS NULL OR line_cost >= 0);
COMMENT ON COLUMN kadiwa_sale_items.unit_cost IS 'Cost price per unit when sold. NULL for items sold before cost prices were recorded.';
COMMENT ON COLUMN kadiwa_sale_items.line_cost IS 'quantity x unit_cost, rounded to centavos.';

ALTER TABLE kadiwa_sales ADD COLUMN IF NOT EXISTS cost_of_goods NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE kadiwa_sales DROP CONSTRAINT IF EXISTS kadiwa_sales_cost_of_goods_check;
ALTER TABLE kadiwa_sales ADD CONSTRAINT kadiwa_sales_cost_of_goods_check CHECK (cost_of_goods >= 0);
COMMENT ON COLUMN kadiwa_sales.cost_of_goods IS 'Total cost price of the store items sold from the inventory (sum of kadiwa_sale_items.line_cost).';
COMMENT ON COLUMN kadiwa_sales.net_sales IS 'Net income of the sale: groceries + vegetables + meat - total_expenses - cost_of_goods. Net income and dividends read it.';

-- New and edited products must have a cost price (the API requires it). Products
-- saved before may still have none until it is entered; they cannot be sold until then.
COMMENT ON COLUMN kadiwa_inventory.cost_price IS 'Cost price (puhunan) per unit. Required for new and edited products and before a product can be sold; the inventory value and the cost of goods use it.';
