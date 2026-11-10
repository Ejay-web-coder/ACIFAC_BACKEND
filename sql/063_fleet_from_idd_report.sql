-- ACIFAC's fleet again after the machinery data was cleared (November 2026),
-- from the PhilMech IDD report for January-July 2026: 2 tractors with rotavator
-- and 2 harvesters, all paid per service.
--   RT-01  Tractor w/ Rotavator 1  delivered 2025-02-21, "always repair" (report)
--   RT-02  Tractor w/ Rotavator 2  operational; delivery date not on the report
--   HK-01  Harvester 1             delivered 2020-12-08, operational (report)
--   HK-02  Harvester 2             acquired 2026-10-09 (as recorded by 038), operational
-- Rates from the report's lists of farmer clients, the same for both units:
--   Rotavator  per ha  2,800 (Jan-Apr 2026), then 3,800 member / 4,000 non-member
--   Squadrone  per ha  3,500 (Apr 2026), then 3,400
--   Tudling    per ha  1,800
--   Harvesting per 100 bags  10 bags member / 12 bags non-member
-- The office can change dates, purchase cost and rates in Details & rates.
--
-- Runs only while there is no machine at all, so it never touches a fleet that
-- was set up by hand. Additive. Reversal (manual, only while the machines have
-- no records): DELETE FROM machinery WHERE id IN ('RT-01', 'RT-02', 'HK-01', 'HK-02');
DO $$
DECLARE
  today CONSTANT DATE := (NOW() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('acifac-machinery-id'));
  IF EXISTS (SELECT 1 FROM machinery) THEN
    RETURN;
  END IF;

  INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, delivery_date, condition, pricing_mode) VALUES
    ('RT-01', 'Tractor w/ Rotavator 1', 'Tractor w/ Rotavator', 0, 'available', DATE '2025-02-21', DATE '2025-02-21', 'always_repair', 'per_service'),
    ('RT-02', 'Tractor w/ Rotavator 2', 'Tractor w/ Rotavator', 0, 'available', today, NULL, 'operational', 'per_service'),
    ('HK-01', 'Harvester 1', 'Harvester', 0, 'available', DATE '2020-12-08', DATE '2020-12-08', 'operational', 'per_service'),
    ('HK-02', 'Harvester 2', 'Harvester', 0, 'available', DATE '2026-10-09', NULL, 'operational', 'per_service');

  INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, effective_to)
  SELECT m.id, r.service_type, r.unit, r.member_rate, r.non_member_rate, r.effective_from, r.effective_to
  FROM (VALUES ('RT-01'), ('RT-02')) AS m(id)
  CROSS JOIN (VALUES
    ('Rotavator', 'per_ha', 2800, 2800, DATE '2026-01-01', DATE '2026-04-30'),
    ('Rotavator', 'per_ha', 3800, 4000, DATE '2026-05-01', NULL::date),
    ('Squadrone', 'per_ha', 3500, 3500, DATE '2026-04-01', DATE '2026-04-30'),
    ('Squadrone', 'per_ha', 3400, 3400, DATE '2026-05-01', NULL::date),
    ('Tudling', 'per_ha', 1800, 1800, DATE '2026-01-01', NULL::date)
  ) AS r(service_type, unit, member_rate, non_member_rate, effective_from, effective_to)
  UNION ALL
  SELECT m.id, 'Harvesting', 'per_100_bags', 10, 12, DATE '2020-12-08', NULL
  FROM (VALUES ('HK-01'), ('HK-02')) AS m(id);
END $$;
