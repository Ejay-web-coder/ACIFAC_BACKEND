-- The organizational chart as a list of entries, so the office can add
-- positions (a fourth director, another staff member) and give each a 2x2
-- picture. Each entry belongs to a box of the chart (group_key):
--   audit, election, bod, officers, ethics, education, gad, mediation, manager, staff
-- The positions of the printed chart are created here (position_key set; they
-- can be renamed but not removed); added ones have no position_key. The names
-- already saved in org_chart_positions (055) are carried over. photo is the
-- stored picture's reference (see services/storage.js).
CREATE TABLE IF NOT EXISTS org_chart_entries (
  id SERIAL PRIMARY KEY,
  group_key VARCHAR(30) NOT NULL CHECK (group_key IN ('audit', 'election', 'bod', 'officers', 'ethics', 'education', 'gad', 'mediation', 'manager', 'staff')),
  role VARCHAR(120) NOT NULL CHECK (btrim(role) <> ''),
  holder_name VARCHAR(200) NOT NULL DEFAULT '',
  photo TEXT,
  position_key VARCHAR(60) UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_chart_entries_group ON org_chart_entries(group_key, sort_order, id);

INSERT INTO org_chart_entries (group_key, role, position_key, sort_order) VALUES
  ('audit', 'Chairperson', 'audit.chair', 1), ('audit', 'Vice Chairperson', 'audit.vice', 2), ('audit', 'Secretary', 'audit.secretary', 3),
  ('election', 'Chairperson', 'election.chair', 1), ('election', 'Vice Chairperson', 'election.vice', 2), ('election', 'Secretary', 'election.secretary', 3),
  ('bod', 'Chairperson', 'bod.chair', 1), ('bod', 'Vice Chairperson', 'bod.vice', 2), ('bod', 'Director', 'bod.director1', 3), ('bod', 'Director', 'bod.director2', 4), ('bod', 'Director', 'bod.director3', 5),
  ('officers', 'Secretary', 'officer.secretary', 1), ('officers', 'Treasurer', 'officer.treasurer', 2),
  ('ethics', 'Chairperson', 'ethics.chair', 1), ('ethics', 'Vice Chairperson', 'ethics.vice', 2), ('ethics', 'Secretary', 'ethics.secretary', 3),
  ('education', 'Chairperson', 'education.chair', 1), ('education', 'Vice Chairperson', 'education.vice', 2), ('education', 'Secretary', 'education.secretary', 3),
  ('gad', 'Chairperson', 'gad.chair', 1), ('gad', 'Vice Chairperson', 'gad.vice', 2), ('gad', 'Secretary', 'gad.secretary', 3),
  ('mediation', 'Chairperson', 'mediation.chair', 1), ('mediation', 'Vice Chairperson', 'mediation.vice', 2), ('mediation', 'Secretary', 'mediation.secretary', 3),
  ('manager', 'General Manager', 'staff.manager', 1),
  ('staff', 'Accountant', 'staff.accountant', 1), ('staff', 'Bookkeeper', 'staff.bookkeeper', 2), ('staff', 'Collector', 'staff.collector', 3), ('staff', 'Cashier', 'staff.cashier', 4)
ON CONFLICT (position_key) DO NOTHING;

UPDATE org_chart_entries e
   SET holder_name = p.holder_name, updated_by = p.updated_by, updated_at = p.updated_at
  FROM org_chart_positions p
 WHERE p.position_key = e.position_key AND e.holder_name = '' AND p.holder_name <> '';
