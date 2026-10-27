-- Kadiwa Store purchases of members, written on the day's sale (New Sale):
-- who bought (member ID or name looked up) and for how much. They are part of
-- the day's sales, never more than its total, and count as the member's
-- business with the cooperative for the patronage refund: 1 point per PHP 100,
-- like machinery fees and loan interest (see services/patronage.js).
CREATE TABLE IF NOT EXISTS kadiwa_sale_members (
  id BIGSERIAL PRIMARY KEY,
  sale_id VARCHAR(30) NOT NULL REFERENCES kadiwa_sales(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- As they were on the day, for the sale's record.
  member_number VARCHAR(50) NOT NULL,
  member_name VARCHAR(200) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_kadiwa_sale_members_member ON kadiwa_sale_members (member_id);

COMMENT ON TABLE kadiwa_sale_members IS 'Members who bought at the Kadiwa Store on a day''s sale, and how much: their patronage business (1 point per PHP 100).';

-- Reversal (manual, only if needed):
--   DROP TABLE kadiwa_sale_members;
