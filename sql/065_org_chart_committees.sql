-- The office can add committees of its own to the organizational chart (beside
-- Ethics, Education & Training, GAD and Mediation & Conciliation). Each added
-- committee is a box with a title; its positions are org_chart_entries whose
-- group_key is the committee's key ('c-' followed by letters and digits).
CREATE TABLE IF NOT EXISTS org_chart_committees (
  committee_key VARCHAR(30) PRIMARY KEY CHECK (committee_key ~ '^c-[a-z0-9]{4,24}$'),
  title VARCHAR(120) NOT NULL CHECK (btrim(title) <> ''),
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE org_chart_entries DROP CONSTRAINT IF EXISTS org_chart_entries_group_key_check;
ALTER TABLE org_chart_entries ADD CONSTRAINT org_chart_entries_group_key_check
  CHECK (group_key IN ('audit', 'election', 'bod', 'officers', 'ethics', 'education', 'gad', 'mediation', 'manager', 'staff') OR group_key ~ '^c-[a-z0-9]{4,24}$');
