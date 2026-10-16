-- Both hand tractors are paid per service (per hectare), recorded under
-- Machinery > Services like Hand Tractor 2, and the first one is no longer
-- called "Kubota" (October 2026).
--   * "Hand Tractor (Kubota)" from 006 is renamed "Hand Tractor" and becomes
--     per service. Members can no longer book it by the day; its past bookings
--     stay, under the new name.
--   * It gets the rates Hand Tractor 2 charges on 2026-10-15, from that day:
--     each service type with its member and non-member rate. The office can
--     change them in the machine's Details & rates.
-- Runs only while a tractor is still named Kubota; additive otherwise (no
-- record is removed). Reversal (manual): set the name and pricing_mode back and
-- delete the rates added from 2026-10-15 for that machine.
DO $$
DECLARE
  switched CONSTANT DATE := DATE '2026-10-15';
  tractor machinery%ROWTYPE;
  new_name TEXT;
  twin_id VARCHAR(20);
BEGIN
  FOR tractor IN SELECT * FROM machinery WHERE name ~* 'kubota' AND lower(type) = 'tractor' ORDER BY id LOOP
    new_name := btrim(regexp_replace(regexp_replace(tractor.name, '\(?\s*kubota\s*\)?', '', 'gi'), '\s+', ' ', 'g'));
    IF new_name = '' THEN new_name := 'Hand Tractor'; END IF;

    UPDATE machinery SET name = new_name, pricing_mode = 'per_service', updated_at = NOW() WHERE id = tractor.id;
    -- Bookings keep a copy of the machine's name; they show the new one too.
    UPDATE machinery_operations SET machinery_name = new_name WHERE machinery_id = tractor.id AND machinery_name = tractor.name;

    -- The rates of the other per-service hand tractor, unless this one has rates already.
    IF NOT EXISTS (SELECT 1 FROM machinery_service_rates WHERE machinery_id = tractor.id) THEN
      SELECT m.id INTO twin_id
      FROM machinery m
      WHERE m.id <> tractor.id AND lower(m.type) = 'tractor' AND m.pricing_mode = 'per_service' AND m.parent_machinery_id IS NULL
        AND EXISTS (SELECT 1 FROM machinery_service_rates r WHERE r.machinery_id = m.id)
      ORDER BY m.id LIMIT 1;
      IF twin_id IS NOT NULL THEN
        INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, effective_to)
        SELECT tractor.id, service_type, unit, member_rate, non_member_rate, GREATEST(effective_from, switched), effective_to
        FROM machinery_service_rates
        WHERE machinery_id = twin_id AND (effective_to IS NULL OR effective_to >= switched)
        ORDER BY service_type, effective_from;
      END IF;
    END IF;
  END LOOP;
END $$;
