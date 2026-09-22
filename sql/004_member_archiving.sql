ALTER TABLE members
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE members
  DROP CONSTRAINT IF EXISTS members_status_check;

ALTER TABLE members
  ADD CONSTRAINT members_status_check CHECK (status IN ('active', 'inactive', 'suspended', 'archived'));

CREATE INDEX IF NOT EXISTS idx_members_archived_at ON members(archived_at);
CREATE INDEX IF NOT EXISTS idx_members_archived_by ON members(archived_by);