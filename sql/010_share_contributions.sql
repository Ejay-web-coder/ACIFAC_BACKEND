CREATE TABLE IF NOT EXISTS share_contributions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  contribution_date DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method VARCHAR(50),
  reference_number VARCHAR(100),
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_contributions_member_date
  ON share_contributions(member_id, contribution_date DESC, id DESC);

INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes)
SELECT m.id, m.share_capital, COALESCE(m.membership_date, m.created_at::date), 'Legacy',
       'LEGACY-' || m.id, 'Imported from the member share capital balance.'
FROM members m
WHERE m.share_capital > 0
  AND NOT EXISTS (
    SELECT 1 FROM share_contributions sc WHERE sc.member_id = m.id
  );