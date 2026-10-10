-- ACIFAC's fleet as of October 2026: 2 harvesters, 2 hand tractors,
-- 2 rotavators, 1 water pump and 1 rice thresher.
--   * The "Tractor with Rotavator" added by 017 is the second hand tractor:
--     renamed "Hand Tractor 2"; its rates, condition and dates stay.
--   * "Harvester 2" and "Rotavator 2" are added, each a copy of the unit it
--     twins (type, pricing, daily fee, condition, and for the harvester its
--     current service rates), acquired 2026-10-09. Delivery date, purchase cost
--     and attachment are left for the office to fill in (Details & rates).
-- Each step runs only when still needed, with the next free M-### ID under the
-- same lock as the Add Machine form. Additive: no record is removed.
DO $$
DECLARE
  acquired CONSTANT DATE := DATE '2026-10-09';
  next_number INTEGER;
  new_id VARCHAR(20);
  twin machinery%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('acifac-machinery-id'));

  UPDATE machinery SET name = 'Hand Tractor 2', updated_at = NOW()
  WHERE name = 'Tractor with Rotavator' AND lower(type) = 'tractor' AND delivery_date = DATE '2025-02-21';

  -- A second harvester, priced like the first.
  IF (SELECT COUNT(*) FROM machinery WHERE lower(type) = 'harvester') < 2 THEN
    SELECT * INTO twin FROM machinery WHERE lower(type) = 'harvester' ORDER BY id LIMIT 1;
    IF FOUND THEN
      SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\D', '', 'g'), '')::int), 0) + 1 INTO next_number FROM machinery WHERE id ~ '^M-[0-9]+$';
      new_id := 'M-' || lpad(next_number::text, 3, '0');
      INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, condition, pricing_mode)
      VALUES (new_id, 'Harvester 2', twin.type, twin.daily_fee, 'available', acquired, twin.condition, twin.pricing_mode);
      -- The rates in force for the first harvester from the day the second was acquired.
      INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, effective_to)
      SELECT new_id, service_type, unit, member_rate, non_member_rate, GREATEST(effective_from, acquired), effective_to
      FROM machinery_service_rates
      WHERE machinery_id = twin.id AND (effective_to IS NULL OR effective_to >= acquired);
    END IF;
  END IF;

  -- A second rotavator, rented by the day like the first.
  IF (SELECT COUNT(*) FROM machinery WHERE lower(name) LIKE 'rotavator%') < 2 THEN
    SELECT * INTO twin FROM machinery WHERE lower(name) LIKE 'rotavator%' ORDER BY id LIMIT 1;
    IF FOUND THEN
      SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\D', '', 'g'), '')::int), 0) + 1 INTO next_number FROM machinery WHERE id ~ '^M-[0-9]+$';
      new_id := 'M-' || lpad(next_number::text, 3, '0');
      INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, condition, pricing_mode)
      VALUES (new_id, 'Rotavator 2', twin.type, twin.daily_fee, 'available', acquired, twin.condition, twin.pricing_mode);
    END IF;
  END IF;
END $$;

-- Reversal (manual, only if needed, and only while the new units have no records):
--   DELETE FROM machinery_service_rates WHERE machinery_id = (SELECT id FROM machinery WHERE name = 'Harvester 2');
--   DELETE FROM machinery WHERE name IN ('Harvester 2', 'Rotavator 2') AND acquisition_date = DATE '2026-10-09';
--   UPDATE machinery SET name = 'Tractor with Rotavator' WHERE name = 'Hand Tractor 2' AND delivery_date = DATE '2025-02-21';
