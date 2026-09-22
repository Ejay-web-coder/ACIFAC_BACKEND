-- Additive fields for the agricultural loan application. Existing loan and payment
-- records remain valid; these columns snapshot the application at submission time.
ALTER TABLE loan_requests
  ADD COLUMN IF NOT EXISTS member_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS borrower_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS borrower_phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS borrower_address TEXT,
  ADD COLUMN IF NOT EXISTS borrower_age INTEGER,
  ADD COLUMN IF NOT EXISTS borrower_gender VARCHAR(30),
  ADD COLUMN IF NOT EXISTS borrower_civil_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS borrower_occupation VARCHAR(255),
  ADD COLUMN IF NOT EXISTS years_farming NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS farm_location TEXT,
  ADD COLUMN IF NOT EXISTS barangay VARCHAR(150),
  ADD COLUMN IF NOT EXISTS municipality VARCHAR(150),
  ADD COLUMN IF NOT EXISTS province VARCHAR(150),
  ADD COLUMN IF NOT EXISTS farm_area NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS crops_planted TEXT,
  ADD COLUMN IF NOT EXISTS crop_season VARCHAR(100),
  ADD COLUMN IF NOT EXISTS irrigation_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS irrigation_other TEXT,
  ADD COLUMN IF NOT EXISTS loan_mode VARCHAR(20),
  ADD COLUMN IF NOT EXISTS maximum_eligible_amount NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS interest_rate NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS calculated_interest NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS total_repayment NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS in_kind_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS co_maker_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS co_maker_address TEXT,
  ADD COLUMN IF NOT EXISTS co_maker_contact VARCHAR(30),
  ADD COLUMN IF NOT EXISTS co_maker_relationship VARCHAR(100),
  ADD COLUMN IF NOT EXISTS collateral_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS collateral_details TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS loan_request_id INTEGER REFERENCES loan_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS member_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS farm_area NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS maximum_eligible_amount NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS loan_mode VARCHAR(20),
  ADD COLUMN IF NOT EXISTS calculated_interest NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS total_repayment NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS in_kind_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS co_maker_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS co_maker_address TEXT,
  ADD COLUMN IF NOT EXISTS co_maker_contact VARCHAR(30),
  ADD COLUMN IF NOT EXISTS co_maker_relationship VARCHAR(100),
  ADD COLUMN IF NOT EXISTS collateral_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS collateral_details TEXT;

ALTER TABLE loan_requests
  DROP CONSTRAINT IF EXISTS loan_requests_non_negative_application_values;
ALTER TABLE loan_requests
  ADD CONSTRAINT loan_requests_non_negative_application_values CHECK (
    (farm_area IS NULL OR farm_area >= 0) AND
    (maximum_eligible_amount IS NULL OR maximum_eligible_amount >= 0) AND
    (calculated_interest IS NULL OR calculated_interest >= 0) AND
    (total_repayment IS NULL OR total_repayment >= 0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_loan_request_per_type
  ON loan_requests (member_id, loan_type)
  WHERE status = 'pending' AND member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_loans_loan_request_id ON loans(loan_request_id);
