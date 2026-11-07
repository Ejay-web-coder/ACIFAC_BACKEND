-- The cooperative's organizational chart (Admin > Chart; members see it in
-- Settings): who holds each position, as on the printed chart in the office.
-- One row per position that has someone; the positions themselves are fixed
-- in the app (General Assembly, committees, Board of Directors, officers and
-- management staff). Additive only.
CREATE TABLE IF NOT EXISTS org_chart_positions (
  position_key VARCHAR(60) PRIMARY KEY,
  holder_name VARCHAR(200) NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
