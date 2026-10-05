-- The parts of the PhilMech "Farm Machinery Utilization Report and Feedback
-- Form" that are not machinery records: the header, the type of farm
-- operation, the buying price of palay, the problems encountered with the
-- suggested solutions, and who prepared and approved it. One form per cropping
-- period and year; the machine figures still come from machinery_services,
-- machinery_expenses and machinery_period_balances. Additive only.
CREATE TABLE IF NOT EXISTS machinery_report_forms (
  id SERIAL PRIMARY KEY,
  cropping_period VARCHAR(3) NOT NULL CHECK (cropping_period IN ('1st', '2nd', '3rd')),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  from_month SMALLINT CHECK (from_month BETWEEN 1 AND 12),
  to_month SMALLINT CHECK (to_month BETWEEN 1 AND 12),
  submission_date DATE,
  fca_name VARCHAR(200) NOT NULL DEFAULT '',
  address VARCHAR(300) NOT NULL DEFAULT '',
  contact_person VARCHAR(200) NOT NULL DEFAULT '',
  contact_number VARCHAR(40) NOT NULL DEFAULT '',
  land_preparation BOOLEAN NOT NULL DEFAULT FALSE,
  harvesting_threshing BOOLEAN NOT NULL DEFAULT FALSE,
  palay_price_fresh NUMERIC(10, 2) CHECK (palay_price_fresh >= 0),
  palay_price_dry NUMERIC(10, 2) CHECK (palay_price_dry >= 0),
  problems TEXT[] NOT NULL DEFAULT '{}' CONSTRAINT machinery_report_form_problems_known CHECK (problems <@ ARRAY[
    'low_acceptability', 'officer_conflict', 'management_training',
    'frequent_breakdown', 'high_maintenance_cost', 'not_compatible',
    'unpaid_collectibles', 'lack_operating_capital', 'poor_fund_management'
  ]::TEXT[]),
  organization_others TEXT NOT NULL DEFAULT '',
  technical_others TEXT NOT NULL DEFAULT '',
  financial_others TEXT NOT NULL DEFAULT '',
  other_problems TEXT NOT NULL DEFAULT '',
  suggested_solutions TEXT NOT NULL DEFAULT '',
  other_comments TEXT NOT NULL DEFAULT '',
  prepared_by VARCHAR(200) NOT NULL DEFAULT '',
  prepared_by_position VARCHAR(100) NOT NULL DEFAULT '',
  approved_by VARCHAR(200) NOT NULL DEFAULT '',
  approved_by_position VARCHAR(100) NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT machinery_report_form_unique UNIQUE (cropping_period, year),
  CONSTRAINT machinery_report_form_months_valid CHECK ((from_month IS NULL) = (to_month IS NULL) AND (from_month IS NULL OR to_month >= from_month))
);

COMMENT ON TABLE machinery_report_forms IS
  'Header, type of farm operation, palay price, problems encountered and signatories of the PhilMech Farm Machinery Utilization Report for one cropping period and year. The machine figures are computed from machinery_services, machinery_expenses and machinery_period_balances.';
COMMENT ON COLUMN machinery_report_forms.problems IS
  'Ticked boxes of "Problems Encountered". An "Others (Pls specify)" box is ticked when its *_others text is filled in.';
COMMENT ON COLUMN machinery_report_forms.approved_by_position IS
  'Printed under the approver''s name: "Name and Signature of <position>" (Chairman/President on the PhilMech form).';

-- Live updates and row level security, as for every other table (see 012).
DROP TRIGGER IF EXISTS trg_acifac_emit_change ON machinery_report_forms;
CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON machinery_report_forms
  FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('');
ALTER TABLE machinery_report_forms ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE machinery_report_forms FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE machinery_report_forms_id_seq FROM anon, authenticated;
  END IF;
END $$;

-- The form ACIFAC submitted for the 1st cropping of 2026 (IDD report Jan-Jul 2026,
-- dated 9-25-2026). Added only when that cropping has no form yet.
INSERT INTO machinery_report_forms (
  cropping_period, year, from_month, to_month, submission_date, fca_name, address, contact_person, contact_number,
  land_preparation, harvesting_threshing, palay_price_fresh, palay_price_dry,
  prepared_by, prepared_by_position, approved_by, approved_by_position)
VALUES (
  '1st', 2026, 1, 7, DATE '2026-09-25', 'AMNAY CABAGAN IRRIGATORS AND FARMERS AGRICULTURE COOPERATIVE',
  'BRGY. BARAHAN, STA. CRUZ, OCCIDENTAL MINDORO', 'RONILO S. SALGADO', '09557733522',
  TRUE, TRUE, 14, 24,
  'EUHYEN M. SALGADO', 'SECRETARY', 'EMERITO V. MENDEZ', 'Chairman/President')
ON CONFLICT (cropping_period, year) DO NOTHING;

-- Reversal (manual, only if needed):
--   DROP TABLE machinery_report_forms;
