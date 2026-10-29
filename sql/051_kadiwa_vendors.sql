-- Kadiwa Store vendors.
--
-- A third login role, VENDOR: the person who sells at the Kadiwa store. An
-- administrator makes the account (a name, a username and a password) in
-- Account Management and can change the name and the password. The vendor
-- signs in on the same login page and can only record the day's sales and
-- expenses (New Sale). Such a sale waits for review (status 'pending'): it is
-- left out of every total, report and net income until an administrator
-- confirms it ('completed') or sends it back ('rejected', with the reason).
-- The audit log records who confirmed or rejected it.
DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%' LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', check_name);
  END LOOP;
  FOR check_name IN SELECT conname FROM pg_constraint WHERE conrelid = 'kadiwa_sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE kadiwa_sales DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'MEMBER', 'VENDOR'));
ALTER TABLE kadiwa_sales ADD CONSTRAINT kadiwa_sales_status_check CHECK (status IN ('completed', 'pending', 'rejected'));

-- Who confirmed or rejected a vendor's sale, when, and the reason given for a rejection.
ALTER TABLE kadiwa_sales ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE kadiwa_sales ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE kadiwa_sales ADD COLUMN IF NOT EXISTS review_notes TEXT;
CREATE INDEX IF NOT EXISTS idx_kadiwa_sales_pending ON kadiwa_sales (created_at) WHERE status = 'pending';

COMMENT ON COLUMN users.role IS 'ADMIN (cooperative office), MEMBER (a member, users.member_id) or VENDOR (Kadiwa store vendor: records sales for review only).';
COMMENT ON COLUMN kadiwa_sales.status IS 'completed: counted in totals and reports. pending: a vendor''s sale waiting for an administrator. rejected: sent back by an administrator (review_notes says why), never counted.';
COMMENT ON COLUMN kadiwa_sales.reviewed_by IS 'The administrator who confirmed or rejected a vendor''s sale.';

-- Reversal (manual, only if needed; first remove or re-role any VENDOR accounts and non-completed sales):
--   ALTER TABLE kadiwa_sales DROP COLUMN review_notes, DROP COLUMN reviewed_at, DROP COLUMN reviewed_by;
--   ALTER TABLE kadiwa_sales DROP CONSTRAINT kadiwa_sales_status_check, ADD CONSTRAINT kadiwa_sales_status_check CHECK (status IN ('completed', 'pending'));
--   ALTER TABLE users DROP CONSTRAINT users_role_check, ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN', 'MEMBER'));
