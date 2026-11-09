-- The About page (Mission & Vision, Chart, Policy and Legal Documents).
-- about_content holds the cooperative's mission, vision and core values as
-- the office writes them: one row (id = 1). legal_documents (012) gains
-- shown_to_members: the office chooses which documents members can open on
-- the About page; documents already uploaded stay visible to administrators
-- only. Additive only.
CREATE TABLE IF NOT EXISTS about_content (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mission TEXT NOT NULL DEFAULT '',
  vision TEXT NOT NULL DEFAULT '',
  core_values TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ
);
INSERT INTO about_content (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS shown_to_members BOOLEAN NOT NULL DEFAULT FALSE;
