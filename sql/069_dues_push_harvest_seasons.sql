-- Rules of the Membership Policy and the Combined Harvester Policy that the
-- system did not follow yet, and notifications that reach the phone.
--   1. Dues: what each member owes under the Membership Policy and pays.
--   2. Phone notifications (Web Push): the browsers that asked for them, the
--      keys the server signs them with, and which notifications were sent.
--   3. Harvester rates by season: dry season per 100 bags, wet season in bags
--      per hectare.
-- Additive, except that each harvester's open-ended all-year Harvesting rate
-- (10 / 12 bags per 100) ends the day before its seasonal rates begin (today).
-- Services already recorded keep the rate they were charged.

-- 1. Dues ---------------------------------------------------------------------
-- Membership Policy: PHP 250 share capital subscription and PHP 50 savings at
-- every meeting, a PHP 250 fine for missing a meeting without a valid reason
-- (attendance "absent"; "excused" is a valid reason), and a PHP 500 transfer
-- fee when a membership is transferred. Meeting dues are added when the
-- meeting's attendance is finalized (activities.dues_charged_at), one row per
-- member and kind. A due is unpaid, paid (payment_id) or waived (waived_at,
-- with the reason). A payment of share capital or savings dues is also a
-- share contribution or a savings deposit, linked here.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS dues_charged_at TIMESTAMPTZ;
COMMENT ON COLUMN activities.dues_charged_at IS
  'Meetings only: when the meeting dues (share capital, savings, absence fines) were added for the members on its final attendance list.';

CREATE TABLE IF NOT EXISTS member_dues_payments (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'Cash',
  reference_number VARCHAR(100),
  notes TEXT NOT NULL DEFAULT '',
  share_contribution_id INTEGER REFERENCES share_contributions(id) ON DELETE SET NULL,
  savings_transaction_id INTEGER REFERENCES savings_transactions(id) ON DELETE SET NULL,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_member_dues_payments_member ON member_dues_payments(member_id, payment_date DESC);

CREATE TABLE IF NOT EXISTS member_dues (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('share_capital', 'savings', 'absence_fine', 'transfer_fee')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  activity_id INTEGER REFERENCES activities(id) ON DELETE RESTRICT,
  description VARCHAR(300) NOT NULL DEFAULT '',
  payment_id INTEGER REFERENCES member_dues_payments(id) ON DELETE RESTRICT,
  waived_at TIMESTAMPTZ,
  waived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  waive_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT member_dues_paid_or_waived CHECK (payment_id IS NULL OR waived_at IS NULL),
  CONSTRAINT member_dues_waive_explained CHECK (waived_at IS NULL OR btrim(COALESCE(waive_reason, '')) <> ''),
  -- Meeting dues belong to a meeting; a transfer fee to none.
  CONSTRAINT member_dues_meeting_kinds CHECK ((kind = 'transfer_fee') = (activity_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS member_dues_meeting_once ON member_dues(activity_id, member_id, kind) WHERE activity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_member_dues_member ON member_dues(member_id, due_date);
CREATE INDEX IF NOT EXISTS idx_member_dues_unpaid ON member_dues(member_id, due_date) WHERE payment_id IS NULL AND waived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_member_dues_payment ON member_dues(payment_id) WHERE payment_id IS NOT NULL;

COMMENT ON TABLE member_dues IS
  'Dues under the Membership Policy: PHP 250 share capital and PHP 50 savings per meeting, PHP 250 absence fine (absent without a valid reason), PHP 500 transfer fee. Unpaid until payment_id or waived_at is set.';

-- 2. Phone notifications (Web Push) ------------------------------------------------
-- One row per browser (phone or computer) that turned phone notifications
-- on for an account. The endpoint is the browser maker's push service.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent VARCHAR(300) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- The server's signing keys (VAPID), made once by the backend when no
-- VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables are set. One row.
CREATE TABLE IF NOT EXISTS push_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- pushed_at: when the notification was sent to the account's phones (or
-- found to have none). Notifications from before today count as sent; new
-- ones start empty. (A default that is not volatile fills the existing rows
-- without rewriting them, so no change event fires for each one.)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE notifications ALTER COLUMN pushed_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_notifications_push_pending ON notifications(id) WHERE pushed_at IS NULL;

-- Marking a notification as sent to the phone is not a change the page needs
-- to show, so an update of pushed_at alone sends no live update.
DROP TRIGGER IF EXISTS trg_acifac_emit_change ON notifications;
CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('', 'user_id');
DROP TRIGGER IF EXISTS trg_acifac_emit_change_update ON notifications;
CREATE TRIGGER trg_acifac_emit_change_update AFTER UPDATE ON notifications
  FOR EACH ROW WHEN ((to_jsonb(OLD) - 'pushed_at') IS DISTINCT FROM (to_jsonb(NEW) - 'pushed_at'))
  EXECUTE FUNCTION acifac_emit_change('', 'user_id');

-- 3. Harvester rates by season -----------------------------------------------------
-- A rate may be for the dry season (tag-araw) or the wet season (tag-ulan),
-- or for the whole year (season empty, as before). Wet-season harvesting is
-- charged by area: bags_per_ha (fee in bags = hectares x rate).
ALTER TABLE machinery_service_rates ADD COLUMN IF NOT EXISTS season VARCHAR(10);
ALTER TABLE machinery_services ADD COLUMN IF NOT EXISTS season VARCHAR(10);

DO $$
DECLARE
  tbl TEXT;
  con RECORD;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['machinery_service_rates', 'machinery_services']
  LOOP
    FOR con IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = tbl::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%unit%' AND pg_get_constraintdef(oid) ILIKE '%per_100_bags%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (unit IN (''per_ha'', ''per_100_bags'', ''per_day'', ''bags_per_ha''))', tbl, tbl || '_unit_check');
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = tbl || '_season_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (season IN (''dry'', ''wet''))', tbl, tbl || '_season_check');
    END IF;
  END LOOP;
END $$;

-- Rate periods of one service on one machine may not overlap, now per season:
-- a dry and a wet rate may run side by side, an all-year rate may not run
-- beside either.
CREATE OR REPLACE FUNCTION machinery_service_rates_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('acifac-machinery-rate:' || NEW.machinery_id || ':' || lower(NEW.service_type)));
  IF EXISTS (
    SELECT 1 FROM machinery_service_rates r
    WHERE r.machinery_id = NEW.machinery_id
      AND lower(r.service_type) = lower(NEW.service_type)
      AND r.id <> NEW.id
      AND (r.season IS NULL OR NEW.season IS NULL OR r.season = NEW.season)
      AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')
  ) THEN
    RAISE EXCEPTION 'The % rate for machine % overlaps another rate period.', NEW.service_type, NEW.machinery_id
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.machinery_service_rates_no_overlap() FROM PUBLIC;

-- The Combined Harvester Policy's shares, from today, on every harvester
-- whose Harvesting rate is still the all-year one:
--   dry season  members 9 bags per 100, non-members 10 per 100
--   wet season  members 4 bags per hectare, non-members 5 per hectare
DO $$
DECLARE
  today DATE := (NOW() AT TIME ZONE 'Asia/Manila')::date;
  open_rate RECORD;
BEGIN
  FOR open_rate IN
    SELECT r.id, r.machinery_id, r.service_type
    FROM machinery_service_rates r
    JOIN machinery m ON m.id = r.machinery_id
    WHERE lower(m.type) LIKE '%harvest%' AND r.unit = 'per_100_bags' AND r.season IS NULL
      AND r.effective_to IS NULL AND r.effective_from < today
      AND NOT EXISTS (
        SELECT 1 FROM machinery_service_rates s
        WHERE s.machinery_id = r.machinery_id AND lower(s.service_type) = lower(r.service_type) AND s.season IS NOT NULL
      )
  LOOP
    UPDATE machinery_service_rates SET effective_to = today - 1 WHERE id = open_rate.id;
    INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, season)
    VALUES (open_rate.machinery_id, open_rate.service_type, 'per_100_bags', 9, 10, today, 'dry'),
           (open_rate.machinery_id, open_rate.service_type, 'bags_per_ha', 4, 5, today, 'wet');
  END LOOP;
END $$;

-- 4. Live updates and row level security, as for every other table (see 012) ---------
-- A member is told about changes to their own dues and dues payments.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['member_dues', 'member_dues_payments']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_acifac_emit_change ON %I', tbl);
    EXECUTE format('CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION acifac_emit_change(%L)', tbl, 'member_id');
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['member_dues', 'member_dues_payments', 'push_subscriptions', 'push_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', tbl);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SEQUENCE member_dues_id_seq, member_dues_payments_id_seq, push_subscriptions_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- Reversal (manual, only if needed; removes every dues record and phone subscription):
--   DROP TABLE member_dues; DROP TABLE member_dues_payments; DROP TABLE push_subscriptions; DROP TABLE push_settings;
--   ALTER TABLE activities DROP COLUMN dues_charged_at; ALTER TABLE notifications DROP COLUMN pushed_at;
--   DELETE FROM machinery_service_rates WHERE season IS NOT NULL AND id NOT IN (SELECT rate_id FROM machinery_services WHERE rate_id IS NOT NULL);
--   UPDATE machinery_service_rates SET effective_to = NULL WHERE <the harvesters' all-year Harvesting rates ended today>;
--   ALTER TABLE machinery_service_rates DROP COLUMN season; ALTER TABLE machinery_services DROP COLUMN season;
--   (and restore the unit checks without 'bags_per_ha' and the overlap function of 017)
