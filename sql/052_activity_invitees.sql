-- Who must attend an activity.
--   * activities.attendee_scope: 'all' (every member on the activity date, as
--     before) or 'selected' (only the members listed in activity_invitees).
--   * activity_invitees: the members an activity with attendee_scope 'selected'
--     is mandatory for. Only they are on its attendance list, only they are
--     recorded absent when the attendance is finalized, and only they see it
--     in their upcoming activities.
-- Additive only: existing activities stay 'all'.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS attendee_scope VARCHAR(10) NOT NULL DEFAULT 'all';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activities_attendee_scope_check') THEN
    ALTER TABLE activities ADD CONSTRAINT activities_attendee_scope_check CHECK (attendee_scope IN ('all', 'selected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS activity_invitees (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_activity_invitees_member ON activity_invitees(member_id);
