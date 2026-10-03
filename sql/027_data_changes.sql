-- Auto refresh where live updates cannot run. Vercel's serverless functions
-- cannot hold the LISTEN connection that Server-Sent Events need, so every
-- change the live-update trigger announces is also written here, and browsers
-- ask GET /api/events/changes every 3 seconds which tables changed since they
-- last asked. Rows hold the same table, op and owning ids as the NOTIFY payload
-- (never record data) and are kept for an hour.
CREATE TABLE IF NOT EXISTS data_changes (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,
  member_id BIGINT,
  user_id BIGINT,
  -- clock_timestamp(): when the row was written, not when its transaction began.
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_data_changes_changed_at ON data_changes(changed_at);

ALTER TABLE data_changes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE data_changes FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE data_changes_id_seq FROM anon, authenticated;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION acifac_emit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  rec JSONB;
  payload JSONB;
  member_ref BIGINT;
BEGIN
  rec := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  payload := jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP);

  IF TG_TABLE_NAME = 'loan_payments' THEN
    SELECT member_id INTO member_ref FROM loans WHERE id = (rec ->> 'loan_id')::int;
    payload := payload || jsonb_build_object('memberId', member_ref);
  ELSIF TG_NARGS > 0 AND TG_ARGV[0] <> '' THEN
    payload := payload || jsonb_build_object('memberId', rec -> TG_ARGV[0]);
  END IF;

  IF TG_NARGS > 1 THEN
    payload := payload || jsonb_build_object('userId', rec -> TG_ARGV[1]);
  END IF;

  PERFORM pg_notify('acifac_events', payload::text);
  INSERT INTO data_changes (table_name, op, member_id, user_id)
  VALUES (TG_TABLE_NAME, TG_OP, (payload ->> 'memberId')::bigint, (payload ->> 'userId')::bigint);
  RETURN NULL;
END;
$$;

COMMENT ON TABLE data_changes IS
  'Which tables changed, for browsers that poll for changes (GET /api/events/changes) where live updates are off. Kept for an hour.';
