-- Deleting a store product. A product never sold is removed. A product that
-- was sold is kept for its past sales (kadiwa_sale_items points to it) and
-- marked deleted: it leaves the inventory, the totals and the sale forms, and
-- the same product can be added again as a new one.
ALTER TABLE kadiwa_inventory
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
COMMENT ON COLUMN kadiwa_inventory.deleted_at IS 'When the product was deleted. Deleted products are kept only for the sales that sold them and are left out of the inventory, its totals and the sale forms.';
COMMENT ON COLUMN kadiwa_inventory.deleted_by IS 'The user who deleted the product.';
CREATE INDEX IF NOT EXISTS idx_kadiwa_inventory_active ON kadiwa_inventory(name) WHERE deleted_at IS NULL;
