-- Kadiwa products are kept like the store's inventory notebook: each product
-- with its size (Century Tuna 150 g, Toyo 200 mL), the quantity on hand in the
-- unit it is counted in (pc, pack, kg ...), the selling price and the cost
-- price (puhunan). The size is optional (loose rice or vegetables have none).
-- The cost price is optional too; when set, the stock is valued at it, as the
-- notebook totals are (quantity x cost price).
ALTER TABLE kadiwa_inventory
  ADD COLUMN IF NOT EXISTS size_value NUMERIC(12, 3),
  ADD COLUMN IF NOT EXISTS size_unit VARCHAR(10),
  ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12, 2);

ALTER TABLE kadiwa_inventory DROP CONSTRAINT IF EXISTS kadiwa_inventory_size_check;
ALTER TABLE kadiwa_inventory ADD CONSTRAINT kadiwa_inventory_size_check CHECK (
  (size_value IS NULL AND size_unit IS NULL)
  OR (size_value > 0 AND size_unit IN ('mL', 'L', 'mg', 'g', 'kg'))
);
ALTER TABLE kadiwa_inventory DROP CONSTRAINT IF EXISTS kadiwa_inventory_cost_price_check;
ALTER TABLE kadiwa_inventory ADD CONSTRAINT kadiwa_inventory_cost_price_check CHECK (cost_price IS NULL OR cost_price >= 0);

-- Store goods are counted by the piece; kg stays available for goods sold by weight.
ALTER TABLE kadiwa_inventory ALTER COLUMN unit SET DEFAULT 'pc';

COMMENT ON COLUMN kadiwa_inventory.size_value IS 'Content size of one unit, e.g. 150 for Century Tuna 150 g. NULL when the product has no size.';
COMMENT ON COLUMN kadiwa_inventory.size_unit IS 'mL, L, mg, g or kg; set together with size_value.';
COMMENT ON COLUMN kadiwa_inventory.unit IS 'What the stock is counted and sold in: pc, pack, bottle, kg ...';
COMMENT ON COLUMN kadiwa_inventory.price IS 'Selling price per unit.';
COMMENT ON COLUMN kadiwa_inventory.cost_price IS 'Cost price (puhunan) per unit. The inventory value uses it, or the selling price when it is not set.';
