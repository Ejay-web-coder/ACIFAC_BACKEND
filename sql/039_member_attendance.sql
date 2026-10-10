-- Member attendance: the cooperative's activities (community development,
-- educational and training activities, meetings) and who attended each one.
--   * activities: one row per activity, scheduled, completed or cancelled.
--     Attendance is final once attendance_finalized_at is set: the office
--     marked the members it saw, and every active member it did not mark was
--     recorded absent (activity_attendance.source = 'finalization'). Only
--     completed activities with final attendance count in attendance rates.
--   * activity_attendance: at most one row per activity and member, present,
--     late, absent or excused. A correction updates the row; the value before
--     it is kept in audit_logs (ATTENDANCE_CORRECTED).
-- Additive only: no existing table or record is changed.
CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL CHECK (btrim(title) <> ''),
  category VARCHAR(30) NOT NULL CHECK (category IN ('community_development', 'education_training', 'meeting')),
  activity_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  venue VARCHAR(200) NOT NULL CHECK (btrim(venue) <> ''),
  description TEXT NOT NULL DEFAULT '',
  organizer VARCHAR(200) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  attendance_finalized_at TIMESTAMPTZ,
  attendance_finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancellation_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activities_end_after_start CHECK (end_time > start_time),
  -- Final attendance belongs to an activity that took place.
  CONSTRAINT activities_final_is_completed CHECK (attendance_finalized_at IS NULL OR status = 'completed'),
  CONSTRAINT activities_cancelled_when CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(activity_date DESC, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_activities_status_date ON activities(status, activity_date);
CREATE INDEX IF NOT EXISTS idx_activities_category_date ON activities(category, activity_date);

COMMENT ON TABLE activities IS
  'Cooperative activities whose attendance is monitored: community development, educational and training activities, and meetings. Cancelled activities are kept but never counted.';
COMMENT ON COLUMN activities.attendance_finalized_at IS
  'When the attendance list was finalized: unmarked active members were recorded absent and the activity became completed. Only completed activities with final attendance count in attendance rates.';

CREATE TABLE IF NOT EXISTS activity_attendance (
  id SERIAL PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  attendance_status VARCHAR(10) NOT NULL CHECK (attendance_status IN ('present', 'late', 'absent', 'excused')),
  check_in_time TIME,
  remarks VARCHAR(500) NOT NULL DEFAULT '',
  source VARCHAR(20) NOT NULL DEFAULT 'office' CHECK (source IN ('office', 'finalization')),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activity_attendance_once UNIQUE (activity_id, member_id),
  CONSTRAINT activity_attendance_check_in_attended CHECK (check_in_time IS NULL OR attendance_status IN ('present', 'late'))
);
CREATE INDEX IF NOT EXISTS idx_activity_attendance_member ON activity_attendance(member_id, activity_id);

COMMENT ON TABLE activity_attendance IS
  'Attendance of one member at one activity (never two rows for the same pair). Present and late count as attended; absent and excused do not. Corrections are logged in audit_logs.';
COMMENT ON COLUMN activity_attendance.source IS
  'office: marked by the office. finalization: the member was not marked and was recorded absent when the attendance was finalized.';

-- Live updates and row level security, as for every other table (see 012).
-- Members are told about their own attendance rows only.
DROP TRIGGER IF EXISTS trg_acifac_emit_change ON activities;
CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON activities
  FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('');
DROP TRIGGER IF EXISTS trg_acifac_emit_change ON activity_attendance;
CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON activity_attendance
  FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('member_id');
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_attendance ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE activities, activity_attendance FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE activities_id_seq, activity_attendance_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- Reversal (manual, only if needed; removes every attendance record):
--   DROP TABLE activity_attendance; DROP TABLE activities;
