-- Kadiwa Store branches.
--   * kadiwa_branches: each store of the cooperative. The store there was
--     until now becomes branch 1, "Main Store" (it can be renamed). A closed
--     branch keeps its records but takes no new sales or products.
--   * kadiwa_inventory.branch_id: each branch keeps its own stock; a sale at a
--     branch takes store items only from that branch's stock.
--   * kadiwa_sales.branch_id: the branch where the sale was made. Totals, net
--     income and dividends still add up every branch.
--   * users.kadiwa_branch_id: the branch a Kadiwa vendor sells at; their sales
--     are always for it.
-- Existing products, sales and vendors go to branch 1. Rows written without a
-- branch (scanned forms) also go to branch 1.
CREATE TABLE IF NOT EXISTS kadiwa_branches (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (btrim(name) <> ''),
  address VARCHAR(300) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kadiwa_branches_name ON kadiwa_branches (LOWER(btrim(name)));
INSERT INTO kadiwa_branches (id, name) VALUES (1, 'Main Store') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('kadiwa_branches', 'id'), GREATEST((SELECT MAX(id) FROM kadiwa_branches), 1));

ALTER TABLE kadiwa_inventory ADD COLUMN IF NOT EXISTS branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES kadiwa_branches(id);
ALTER TABLE kadiwa_sales ADD COLUMN IF NOT EXISTS branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES kadiwa_branches(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS kadiwa_branch_id INTEGER REFERENCES kadiwa_branches(id);
UPDATE users SET kadiwa_branch_id = 1 WHERE role = 'VENDOR' AND kadiwa_branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_kadiwa_inventory_branch ON kadiwa_inventory(branch_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kadiwa_sales_branch_date ON kadiwa_sales(branch_id, sale_date);
