-- ACIFAC's fleet is now four machines, each with its own ID, all paid per
-- service (per hectare or per 100 bags of palay) and booked by members for a
-- range of days; nothing is rented by the day any more (Day Rentals removed):
--   RT-01, RT-02  Rotavator w/ Tractor   (land preparation, per hectare)
--   HK-01, HK-02  Harvester Kubota       (harvesting, per 100 bags)
--
-- The office chose a fresh start (November 2026): every earlier machine is
-- deleted together with everything recorded on it - bookings, services and
-- their payments, day-rental payments, expenses and the beginning cash of each
-- cropping. The PhilMech report form (machinery_report_forms) is not tied to a
-- machine and stays.
--
-- The rates the office had set are kept: the new rotavators get the rates of
-- the per-service tractor with the longest rate history, the new harvesters
-- those of the harvester charged per 100 bags, with the same effective dates.
-- They can be changed in each machine's Details & rates.
--
-- Runs once. Not reversible: the deleted records are gone.
DO $$
DECLARE
  tractor_source VARCHAR(20);
  harvester_source VARCHAR(20);
BEGIN
  -- Already done (or the fleet was set up by hand): nothing to do.
  IF EXISTS (SELECT 1 FROM machinery WHERE id IN ('RT-01', 'RT-02', 'HK-01', 'HK-02')) THEN
    RETURN;
  END IF;

  SELECT m.id INTO tractor_source
  FROM machinery m JOIN machinery_service_rates r ON r.machinery_id = m.id AND r.unit = 'per_ha'
  WHERE m.pricing_mode = 'per_service'
  GROUP BY m.id ORDER BY MIN(r.effective_from), COUNT(*) DESC, m.id LIMIT 1;
  SELECT m.id INTO harvester_source
  FROM machinery m JOIN machinery_service_rates r ON r.machinery_id = m.id AND r.unit = 'per_100_bags'
  WHERE m.pricing_mode = 'per_service'
  GROUP BY m.id ORDER BY MIN(r.effective_from), COUNT(*) DESC, m.id LIMIT 1;

  CREATE TEMP TABLE kept_rates ON COMMIT DROP AS
  SELECT CASE WHEN machinery_id = tractor_source THEN 'rotavator' ELSE 'harvester' END AS kind,
         service_type, unit, member_rate, non_member_rate, effective_from, effective_to
  FROM machinery_service_rates
  WHERE machinery_id IN (tractor_source, harvester_source);

  DELETE FROM machinery_rental_payments;
  DELETE FROM machinery_service_payments;
  DELETE FROM machinery_services;
  DELETE FROM machinery_operations;
  DELETE FROM rental_requests;
  DELETE FROM machinery_expenses;
  DELETE FROM machinery_period_balances;
  DELETE FROM machinery_service_rates;
  UPDATE machinery SET parent_machinery_id = NULL WHERE parent_machinery_id IS NOT NULL;
  DELETE FROM machinery;

  INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, condition, pricing_mode) VALUES
    ('RT-01', 'Rotavator w/ Tractor 1', 'Rotavator w/ Tractor', 0, 'available', (NOW() AT TIME ZONE 'Asia/Manila')::date, 'operational', 'per_service'),
    ('RT-02', 'Rotavator w/ Tractor 2', 'Rotavator w/ Tractor', 0, 'available', (NOW() AT TIME ZONE 'Asia/Manila')::date, 'operational', 'per_service'),
    ('HK-01', 'Harvester Kubota 1', 'Harvester Kubota', 0, 'available', (NOW() AT TIME ZONE 'Asia/Manila')::date, 'operational', 'per_service'),
    ('HK-02', 'Harvester Kubota 2', 'Harvester Kubota', 0, 'available', (NOW() AT TIME ZONE 'Asia/Manila')::date, 'operational', 'per_service');

  INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, effective_to)
  SELECT m.id, k.service_type, k.unit, k.member_rate, k.non_member_rate, k.effective_from, k.effective_to
  FROM kept_rates k
  JOIN (VALUES ('RT-01', 'rotavator'), ('RT-02', 'rotavator'), ('HK-01', 'harvester'), ('HK-02', 'harvester')) AS m(id, kind) ON m.kind = k.kind
  ORDER BY m.id, k.service_type, k.effective_from;
END $$;
