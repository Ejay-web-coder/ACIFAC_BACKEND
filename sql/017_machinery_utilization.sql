-- Machinery utilization for the PhilMech "Farm Machinery Utilization Report and
-- Feedback Form" and the "Cashflow Statement of Farm Machinery Operation per
-- Cropping". Additive only: no column or table is dropped or renamed, and the
-- per-day rental flow (rental_requests, machinery_operations) is unchanged.
-- Existing machines become pricing_mode 'per_day', which is how they work today.

-- 1. Machine details used by the report ---------------------------------------
-- condition is the machine's state as reported to PhilMech; status keeps its
-- meaning for rentals. parent_machinery_id attaches an implement (Rotavator)
-- to the machine that pulls it (tractor). per_service machines are paid per
-- job (per hectare or per 100 bags) through machinery_services instead of the
-- per-day booking.
ALTER TABLE machinery
  ADD COLUMN IF NOT EXISTS delivery_date DATE,
  ADD COLUMN IF NOT EXISTS condition VARCHAR(20)
    CONSTRAINT machinery_condition_valid CHECK (condition IN ('operational', 'non_operational', 'always_repair', 'idle')),
  ADD COLUMN IF NOT EXISTS parent_machinery_id VARCHAR(20) REFERENCES machinery(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(20) NOT NULL DEFAULT 'per_day'
    CONSTRAINT machinery_pricing_mode_valid CHECK (pricing_mode IN ('per_day', 'per_service'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machinery_not_own_parent') THEN
    ALTER TABLE machinery ADD CONSTRAINT machinery_not_own_parent CHECK (parent_machinery_id IS DISTINCT FROM id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_machinery_parent ON machinery(parent_machinery_id) WHERE parent_machinery_id IS NOT NULL;

-- 2. Service rates ------------------------------------------------------------
-- Rates change mid-season, so every rate has an effective period and a fee
-- always uses the rate valid on the service date. Periods of the same service
-- type on one machine may not overlap (checked below).
CREATE TABLE IF NOT EXISTS machinery_service_rates (
  id SERIAL PRIMARY KEY,
  machinery_id VARCHAR(20) NOT NULL REFERENCES machinery(id) ON DELETE CASCADE,
  service_type VARCHAR(60) NOT NULL CHECK (btrim(service_type) <> ''),
  unit VARCHAR(20) NOT NULL CHECK (unit IN ('per_ha', 'per_100_bags', 'per_day')),
  member_rate NUMERIC(12, 2) NOT NULL CHECK (member_rate >= 0),
  non_member_rate NUMERIC(12, 2) NOT NULL CHECK (non_member_rate >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT machinery_service_rate_dates_valid CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_machinery_service_rates_machine ON machinery_service_rates(machinery_id, lower(service_type), effective_from);

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
      AND daterange(r.effective_from, r.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')
  ) THEN
    RAISE EXCEPTION 'The % rate for machine % overlaps another rate period.', NEW.service_type, NEW.machinery_id
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_machinery_service_rates_no_overlap ON machinery_service_rates;
CREATE TRIGGER trg_machinery_service_rates_no_overlap
  BEFORE INSERT OR UPDATE ON machinery_service_rates
  FOR EACH ROW EXECUTE FUNCTION machinery_service_rates_no_overlap();

-- 3. Services: one row per job done for a farmer ---------------------------------
-- fee_amount is the peso value of the fee. For harvesting (per_100_bags) the
-- fee is taken in bags: fee_bags = total_bags x rate / 100, valued at
-- bag_value (entered, or kg_per_bag x price_per_kg). computed_fee_amount keeps
-- the fee from the rate when staff change it, with fee_override_reason.
-- amount_paid is maintained from machinery_service_payments (section 4);
-- balance and payment_status follow from the amounts automatically.
CREATE TABLE IF NOT EXISTS machinery_services (
  id SERIAL PRIMARY KEY,
  machinery_id VARCHAR(20) NOT NULL REFERENCES machinery(id),
  service_type VARCHAR(60) NOT NULL CHECK (btrim(service_type) <> ''),
  service_date DATE NOT NULL,
  cropping_period VARCHAR(3) NOT NULL CHECK (cropping_period IN ('1st', '2nd', '3rd')),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  client_category VARCHAR(20) NOT NULL CHECK (client_category IN ('member', 'non_member')),
  member_id INTEGER REFERENCES members(id) ON DELETE RESTRICT,
  client_name VARCHAR(200) NOT NULL CHECK (btrim(client_name) <> ''),
  client_address VARCHAR(300) NOT NULL DEFAULT '',
  unit VARCHAR(20) NOT NULL CHECK (unit IN ('per_ha', 'per_100_bags', 'per_day')),
  area_ha NUMERIC(10, 4) NOT NULL DEFAULT 0 CHECK (area_ha >= 0),
  days INTEGER CHECK (days > 0),
  total_bags NUMERIC(10, 2) CHECK (total_bags >= 0),
  fee_bags NUMERIC(10, 2) CHECK (fee_bags >= 0),
  bag_value NUMERIC(12, 2) CHECK (bag_value >= 0),
  kg_per_bag NUMERIC(8, 2) CHECK (kg_per_bag > 0),
  price_per_kg NUMERIC(10, 2) CHECK (price_per_kg >= 0),
  rate_id INTEGER REFERENCES machinery_service_rates(id) ON DELETE SET NULL,
  rate_used NUMERIC(12, 2) NOT NULL CHECK (rate_used >= 0),
  computed_fee_amount NUMERIC(12, 2) CHECK (computed_fee_amount >= 0),
  fee_amount NUMERIC(12, 2) NOT NULL CHECK (fee_amount >= 0),
  fee_override_reason TEXT,
  amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  balance NUMERIC(12, 2) GENERATED ALWAYS AS (fee_amount - amount_paid) STORED,
  payment_status VARCHAR(10) GENERATED ALWAYS AS (
    CASE WHEN amount_paid >= fee_amount THEN 'full' WHEN amount_paid > 0 THEN 'partial' ELSE 'unpaid' END
  ) STORED CHECK (payment_status IN ('unpaid', 'partial', 'full')),
  rental_request_id INTEGER REFERENCES rental_requests(id) ON DELETE SET NULL,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT machinery_service_non_member_unlinked CHECK (client_category = 'member' OR member_id IS NULL),
  CONSTRAINT machinery_service_not_overpaid CHECK (amount_paid <= fee_amount),
  CONSTRAINT machinery_service_override_explained CHECK (
    computed_fee_amount IS NULL OR computed_fee_amount = fee_amount OR btrim(COALESCE(fee_override_reason, '')) <> ''
  )
);
CREATE INDEX IF NOT EXISTS idx_machinery_services_machine ON machinery_services(machinery_id);
CREATE INDEX IF NOT EXISTS idx_machinery_services_date ON machinery_services(service_date);
CREATE INDEX IF NOT EXISTS idx_machinery_services_member ON machinery_services(member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_machinery_services_period ON machinery_services(year, cropping_period);
CREATE INDEX IF NOT EXISTS idx_machinery_services_rental_request ON machinery_services(rental_request_id) WHERE rental_request_id IS NOT NULL;

-- 4. Payment history ---------------------------------------------------------------
-- Every collection is a row here; the trigger keeps machinery_services.amount_paid
-- equal to their sum, so the service's CHECK rejects an overpayment.
CREATE TABLE IF NOT EXISTS machinery_service_payments (
  id SERIAL PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES machinery_services(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_machinery_service_payments_service ON machinery_service_payments(service_id);
CREATE INDEX IF NOT EXISTS idx_machinery_service_payments_date ON machinery_service_payments(payment_date);

CREATE OR REPLACE FUNCTION machinery_service_payments_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target INTEGER;
BEGIN
  FOREACH target IN ARRAY (
    CASE
      WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.service_id]
      WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.service_id]
      ELSE ARRAY[OLD.service_id, NEW.service_id]
    END
  )
  LOOP
    UPDATE machinery_services s
    SET amount_paid = (SELECT COALESCE(SUM(p.amount), 0) FROM machinery_service_payments p WHERE p.service_id = s.id),
        updated_at = NOW()
    WHERE s.id = target;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_machinery_service_payments_sync ON machinery_service_payments;
CREATE TRIGGER trg_machinery_service_payments_sync
  AFTER INSERT OR UPDATE OR DELETE ON machinery_service_payments
  FOR EACH ROW EXECUTE FUNCTION machinery_service_payments_sync();

-- 5. Operating expenses --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS machinery_expenses (
  id SERIAL PRIMARY KEY,
  machinery_id VARCHAR(20) NOT NULL REFERENCES machinery(id),
  expense_date DATE NOT NULL,
  cropping_period VARCHAR(3) NOT NULL CHECK (cropping_period IN ('1st', '2nd', '3rd')),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  category VARCHAR(30) NOT NULL CHECK (category IN ('fuel', 'labor', 'repair_maintenance', 'other')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_machinery_expenses_machine ON machinery_expenses(machinery_id);
CREATE INDEX IF NOT EXISTS idx_machinery_expenses_date ON machinery_expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_machinery_expenses_period ON machinery_expenses(year, cropping_period);

-- 6. Beginning cash and other income per machine and cropping ------------------
CREATE TABLE IF NOT EXISTS machinery_period_balances (
  id SERIAL PRIMARY KEY,
  machinery_id VARCHAR(20) NOT NULL REFERENCES machinery(id),
  cropping_period VARCHAR(3) NOT NULL CHECK (cropping_period IN ('1st', '2nd', '3rd')),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  beginning_cash NUMERIC(12, 2) NOT NULL DEFAULT 0,
  other_income NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (other_income >= 0),
  notes TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT machinery_period_balance_unique UNIQUE (machinery_id, cropping_period, year)
);

-- 7. Live updates and row level security, as for every other table (see 012) --------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['machinery_service_rates', 'machinery_services', 'machinery_service_payments', 'machinery_expenses', 'machinery_period_balances']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_acifac_emit_change ON %I', tbl);
    EXECUTE format('CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION acifac_emit_change(%L)', tbl, '');
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', tbl);
    END IF;
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['machinery_service_rates_no_overlap()', 'machinery_service_payments_sync()']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM anon, authenticated', tbl);
    END IF;
  END LOOP;
END $$;

-- 8. ACIFAC's per-service machines from the Jan-Jul 2026 IDD report --------------
-- Each is added only when missing, with the next free M-### ID (same rule and
-- lock as the Add Machinery form). The existing M-004 Rotavator is attached to
-- the new tractor; it keeps its per-day rentals.
DO $$
DECLARE
  next_number INTEGER;
  harvester_id VARCHAR(20);
  tractor_id VARCHAR(20);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('acifac-machinery-id'));

  SELECT id INTO harvester_id FROM machinery
  WHERE lower(type) = 'harvester' AND delivery_date = DATE '2020-12-08' ORDER BY id LIMIT 1;
  IF harvester_id IS NULL THEN
    SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\D', '', 'g'), '')::int), 0) + 1 INTO next_number FROM machinery WHERE id ~ '^M-[0-9]+$';
    harvester_id := 'M-' || lpad(next_number::text, 3, '0');
    INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, delivery_date, condition, pricing_mode)
    VALUES (harvester_id, 'Harvester', 'Harvester', 0, 'available', DATE '2020-12-08', DATE '2020-12-08', 'operational', 'per_service');
    INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from)
    VALUES (harvester_id, 'Harvesting', 'per_100_bags', 10, 12, DATE '2020-12-08');
  END IF;

  SELECT id INTO tractor_id FROM machinery
  WHERE lower(type) = 'tractor' AND delivery_date = DATE '2025-02-21' ORDER BY id LIMIT 1;
  IF tractor_id IS NULL THEN
    SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\D', '', 'g'), '')::int), 0) + 1 INTO next_number FROM machinery WHERE id ~ '^M-[0-9]+$';
    tractor_id := 'M-' || lpad(next_number::text, 3, '0');
    INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, delivery_date, condition, pricing_mode)
    VALUES (tractor_id, 'Tractor with Rotavator', 'Tractor', 0, 'available', DATE '2025-02-21', DATE '2025-02-21', 'always_repair', 'per_service');
    INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, effective_to) VALUES
      (tractor_id, 'Rotavator', 'per_ha', 2800, 2800, DATE '2026-01-01', DATE '2026-04-30'),
      (tractor_id, 'Rotavator', 'per_ha', 3800, 4000, DATE '2026-05-01', NULL),
      (tractor_id, 'Squadrone', 'per_ha', 3500, 3500, DATE '2026-04-01', DATE '2026-04-30'),
      (tractor_id, 'Squadrone', 'per_ha', 3400, 3400, DATE '2026-05-01', NULL),
      (tractor_id, 'Tudling', 'per_ha', 1800, 1800, DATE '2026-01-01', NULL);
  END IF;

  UPDATE machinery SET parent_machinery_id = tractor_id, updated_at = NOW()
  WHERE id = 'M-004' AND lower(name) = 'rotavator' AND parent_machinery_id IS NULL;
END $$;

-- Reversal (manual, only if needed):
--   DROP TABLE machinery_service_payments, machinery_services, machinery_service_rates,
--     machinery_expenses, machinery_period_balances;
--   DROP FUNCTION machinery_service_rates_no_overlap(), machinery_service_payments_sync();
--   UPDATE machinery SET parent_machinery_id = NULL;
--   DELETE FROM machinery WHERE id IN (<the Harvester and Tractor with Rotavator IDs added above>);
--   ALTER TABLE machinery DROP COLUMN delivery_date, DROP COLUMN condition,
--     DROP COLUMN parent_machinery_id, DROP COLUMN pricing_mode;
