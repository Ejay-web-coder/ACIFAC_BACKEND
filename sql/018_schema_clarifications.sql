-- Follow-up to a schema review: the member full name, the two machinery tables
-- and the Kadiwa payment method. Only members.full_name changes; the rest are
-- table and column descriptions (they show in Supabase's Table Editor).

-- 1. members.full_name ------------------------------------------------------------
-- Production has a generated full_name that was added outside these files as
-- first + middle + last. It left out the suffix (Jr., Sr., III) and put two
-- spaces where there is no middle name. It is recreated to give the name the
-- application shows everywhere (first, middle, last, suffix, single spaces), and
-- added where it was missing so every database has it. Nothing depends on the
-- column (no view, index or constraint on production), so dropping it is safe.
ALTER TABLE members DROP COLUMN IF EXISTS full_name;
ALTER TABLE members ADD COLUMN full_name TEXT GENERATED ALWAYS AS (
  btrim(regexp_replace(
    COALESCE(first_name, '') || ' ' || COALESCE(middle_name, '') || ' ' || COALESCE(last_name, '') || ' ' || COALESCE(suffix, ''),
    '\s+', ' ', 'g'
  ))
) STORED;

COMMENT ON COLUMN members.full_name IS
  'Generated: first, middle and last name and suffix, separated by single spaces (e.g. "Juan Santos Dela Cruz Jr."). Read-only.';

-- 2. Machinery: bookings and services are both current ------------------------------
-- They record different things. A per-day booking reserves a machine for dates;
-- a service is work a machine did and what it earned. A service done under a
-- booking may point to its rental request, but the booking stays where it is.
-- The machine list on the Machinery Operations page is the machinery table,
-- not machinery_operations.
COMMENT ON TABLE machinery IS
  'The fleet: every machine and implement, as listed on the Machinery Operations page. pricing_mode says how a machine earns: per_day machines are booked by members (rental_requests, then machinery_operations); per_service machines are paid per job (machinery_services). An implement points to the tractor that pulls it through parent_machinery_id.';
COMMENT ON TABLE rental_requests IS
  'A member''s request to book a per-day machine for a date range (pending, approved, declined). Approving one creates its machinery_operations row.';
COMMENT ON TABLE machinery_operations IS
  'Current. Booking schedule of per-day machines: one row per approved rental request, with its dates, day-rate fee and scheduled/ongoing/completed status. Used for machine availability, double-booking checks, members'' rental history and the dashboard''s machinery rental revenue. The work a machine did and its payments are in machinery_services.';
COMMENT ON TABLE machinery_services IS
  'Current. One row per job a machine did for a farmer (member or non-member), priced per hectare, per 100 bags or per day from machinery_service_rates, with payments in machinery_service_payments. Source of the PhilMech utilization report and cashflow statement. Bookings are in machinery_operations.';
COMMENT ON COLUMN machinery_services.rental_request_id IS
  'Optional: the rental request (booking) this job was done under. The booking itself stays in machinery_operations.';

-- 3. Kadiwa payment method ------------------------------------------------------------
-- ACIFAC's Kadiwa store takes cash only, so the CHECK allowing only 'cash' is
-- intended. Widen it (and add a choice to the sale form) if that changes.
COMMENT ON COLUMN kadiwa_sales.payment_method IS
  'Always cash: ACIFAC''s Kadiwa store takes cash only. To accept another method, widen kadiwa_sales_payment_method_check and add the choice to the sale form.';
