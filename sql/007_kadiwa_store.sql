CREATE TABLE IF NOT EXISTS kadiwa_inventory (
  id VARCHAR(30) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(30) NOT NULL CHECK (category IN ('Groceries', 'Vegetables', 'Meat', 'Other')),
  stock NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
  price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  reorder_level NUMERIC(12, 2) NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  unit VARCHAR(40) NOT NULL DEFAULT 'kg',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kadiwa_sales (
  id VARCHAR(30) PRIMARY KEY,
  encoder_name VARCHAR(200) NOT NULL,
  groceries NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (groceries >= 0),
  vegetables NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (vegetables >= 0),
  meat NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (meat >= 0),
  total_expenses NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_expenses >= 0),
  net_sales NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash')),
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'pending')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kadiwa_sales_created_at ON kadiwa_sales(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kadiwa_inventory_category ON kadiwa_inventory(category);

INSERT INTO kadiwa_inventory (id, name, category, stock, price, reorder_level, unit)
VALUES
  ('INV-001', 'Rice', 'Groceries', 48, 45, 20, 'kg'),
  ('INV-002', 'Pork', 'Meat', 12, 220, 10, 'kg'),
  ('INV-003', 'Tomatoes', 'Vegetables', 18, 35, 15, 'kg'),
  ('INV-004', 'Cooking Oil', 'Groceries', 7, 120, 10, 'bottle')
ON CONFLICT (id) DO NOTHING;

INSERT INTO kadiwa_sales (id, encoder_name, groceries, vegetables, meat, total_expenses, net_sales, created_at)
VALUES
  ('S-2026-001', 'Juan Dela Cruz', 450, 300, 0, 200, 550, '2026-04-24 10:30:00'),
  ('S-2026-002', 'Maria Santos', 600, 320, 100, 350, 670, '2026-04-24 11:15:00'),
  ('S-2026-003', 'Pedro Reyes', 250, 150, 100, 150, 350, '2026-04-24 14:45:00')
ON CONFLICT (id) DO NOTHING;
