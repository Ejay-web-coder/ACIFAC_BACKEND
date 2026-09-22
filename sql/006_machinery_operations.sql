CREATE TABLE IF NOT EXISTS machinery (
  id VARCHAR(20) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(80) NOT NULL,
  daily_fee NUMERIC(12, 2) NOT NULL CHECK (daily_fee >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'in-use', 'maintenance')),
  acquisition_date DATE NOT NULL,
  last_maintenance DATE,
  next_maintenance DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, last_maintenance, next_maintenance)
VALUES
  ('M-001', 'Hand Tractor (Kubota)', 'Tractor', 600, 'available', '2023-05-10', '2026-03-15', '2026-06-15'),
  ('M-002', 'Rice Thresher', 'Thresher', 800, 'in-use', '2023-08-20', '2026-02-10', '2026-05-10'),
  ('M-003', 'Water Pump', 'Irrigation', 600, 'available', '2024-01-15', '2026-04-01', '2026-07-01'),
  ('M-004', 'Rotavator', 'Tractor', 700, 'maintenance', '2023-11-05', '2026-04-20', '2026-04-27')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rental_requests (
  id SERIAL PRIMARY KEY,
  machinery_id VARCHAR(20) NOT NULL REFERENCES machinery(id),
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  member_name VARCHAR(200) NOT NULL,
  purpose TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  duration INTEGER NOT NULL CHECK (duration > 0),
  rental_fee NUMERIC(12, 2) NOT NULL CHECK (rental_fee >= 0),
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT rental_request_dates_valid CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS machinery_operations (
  id SERIAL PRIMARY KEY,
  rental_request_id INTEGER UNIQUE REFERENCES rental_requests(id) ON DELETE SET NULL,
  machinery_id VARCHAR(20) NOT NULL REFERENCES machinery(id),
  machinery_name VARCHAR(200) NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  member_name VARCHAR(200) NOT NULL,
  purpose TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  duration INTEGER NOT NULL CHECK (duration > 0),
  rental_fee NUMERIC(12, 2) NOT NULL CHECK (rental_fee >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('ongoing', 'completed', 'scheduled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rental_requests_status ON rental_requests(status);
CREATE INDEX IF NOT EXISTS idx_rental_requests_member_id ON rental_requests(member_id);
CREATE INDEX IF NOT EXISTS idx_machinery_operations_start_date ON machinery_operations(start_date);