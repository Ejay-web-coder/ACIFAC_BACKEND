-- 012_production_alignment.sql
-- -----------------------------------------------------------------------------
-- Aligns the live Supabase database with the Express/pg application and adds the
-- tables needed for real (non-mock) features. Written to be idempotent and
-- non-destructive: it never drops a table that holds data and aborts instead of
-- guessing when existing data would need a manual decision.
--
-- Summary of changes
--   1. app_schema_migrations: tracks which sql/ files have been applied.
--   2. members.archived_by: uuid -> integer FK users(id) (the app's auth model).
--      Aborts if any archived_by value is already set (manual mapping required).
--   3. Unused Supabase-Auth design (user_accounts + SECURITY DEFINER helpers +
--      storage policies based on them) is isolated: privileges revoked, storage
--      policies that depend on it removed. Nothing is dropped from user_accounts.
--   4. anon/authenticated roles lose table privileges on application tables; the
--      React app never talks to PostgREST, only to the Express API.
--   5. users: profile + notification preference columns.
--   6. password_reset_tokens.token_digest (SHA-256 lookup instead of bcrypt scan).
--   7. loan_installments: monthly repayment schedule used for overdue tracking.
--   8. loan_requests.review_notes (reason given when a request is declined).
--   9. kadiwa_sale_items (item lines that decrement inventory) + id sequences.
--  10. notifications, announcements, legal_documents, savings_transactions tables.
--  11. Date defaults use Asia/Manila instead of the session time zone.
--  12. Indexes for foreign keys / query patterns used by the API.
--  13. Row-change NOTIFY triggers (ids only, no personal data) for live updates.
--  14. Private storage buckets with size and MIME limits.
-- Reversal notes are at the end of the file.
-- -----------------------------------------------------------------------------

-- 1. Migration tracking --------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. members.archived_by -> users(id) -----------------------------------------
DO $$
DECLARE
  current_type TEXT;
  fk RECORD;
BEGIN
  SELECT data_type INTO current_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'members' AND column_name = 'archived_by';

  IF current_type IS NULL THEN
    ALTER TABLE members ADD COLUMN archived_by INTEGER;
  ELSIF current_type = 'uuid' THEN
    IF EXISTS (SELECT 1 FROM members WHERE archived_by IS NOT NULL) THEN
      RAISE EXCEPTION 'members.archived_by contains uuid values that cannot be mapped to users.id automatically. Map them manually before running this migration.';
    END IF;
    FOR fk IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.members'::regclass AND contype = 'f'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.members'::regclass AND attname = 'archived_by')]::smallint[]
    LOOP
      EXECUTE format('ALTER TABLE members DROP CONSTRAINT %I', fk.conname);
    END LOOP;
    ALTER TABLE members ALTER COLUMN archived_by TYPE INTEGER USING NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.members'::regclass AND contype = 'f'
      AND confrelid = 'public.users'::regclass
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.members'::regclass AND attname = 'archived_by')]::smallint[]
  ) THEN
    ALTER TABLE members ADD CONSTRAINT members_archived_by_fkey
      FOREIGN KEY (archived_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_members_archived_by ON members(archived_by);
CREATE INDEX IF NOT EXISTS idx_members_archived_at ON members(archived_at);

-- Duplicate protection for government-issued RSBSA numbers (only when data is clean).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM members WHERE NULLIF(TRIM(rsbsa_no), '') IS NOT NULL
    GROUP BY LOWER(TRIM(rsbsa_no)) HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_members_rsbsa_unique
      ON members (LOWER(TRIM(rsbsa_no))) WHERE NULLIF(TRIM(rsbsa_no), '') IS NOT NULL;
  ELSE
    RAISE NOTICE 'Duplicate RSBSA numbers exist; unique index not created.';
  END IF;
END $$;

-- 3. Isolate the unused Supabase-Auth design ----------------------------------
DO $$
DECLARE
  fn TEXT;
  pol RECORD;
BEGIN
  IF to_regclass('public.user_accounts') IS NOT NULL THEN
    COMMENT ON TABLE public.user_accounts IS 'DEPRECATED: unused Supabase-Auth design. The application authenticates with public.users + public.sessions.';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON TABLE public.user_accounts FROM anon, authenticated';
    END IF;
  END IF;

  FOREACH fn IN ARRAY ARRAY['current_user_role()', 'current_member_id()', 'is_staff_or_admin()', 'is_admin()', 'get_login_email(text)']
  LOOP
    IF to_regprocedure('public.' || fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC', fn);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM anon, authenticated', fn);
      END IF;
    END IF;
  END LOOP;

  -- Storage policies that relied on user_accounts. Without them only the
  -- backend's service role can read or write objects in the private buckets.
  IF to_regclass('storage.objects') IS NOT NULL THEN
    FOR pol IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN ('staff manage member-documents', 'member reads own documents', 'staff manage member-photos', 'member reads own photo', 'staff manage ocr-uploads')
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
    END LOOP;
  END IF;
END $$;

-- 5. users profile / preferences ----------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50),
  ADD COLUMN IF NOT EXISTS position VARCHAR(120),
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{"emailNotifications": true, "smsNotifications": false, "loanReminders": true}'::jsonb;

-- 6. password reset token digest ----------------------------------------------
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS token_digest CHAR(64);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_digest
  ON password_reset_tokens(token_digest) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_active_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- 7. Loan installment schedule --------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_installments (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  amount_due NUMERIC(14, 2) NOT NULL CHECK (amount_due >= 0),
  principal_due NUMERIC(14, 2) NOT NULL CHECK (principal_due >= 0),
  interest_due NUMERIC(14, 2) NOT NULL CHECK (interest_due >= 0),
  amount_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  principal_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (principal_paid >= 0),
  interest_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (interest_paid >= 0),
  last_payment_date DATE,
  paid_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loan_installments_unique_number UNIQUE (loan_id, installment_number),
  CONSTRAINT loan_installments_paid_within_due CHECK (amount_paid <= amount_due)
);
CREATE INDEX IF NOT EXISTS idx_loan_installments_open_due
  ON loan_installments(due_date) WHERE amount_paid < amount_due;

-- 8. Loan request decision notes -------------------------------------------------
ALTER TABLE loan_requests ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- 9. Kadiwa sale items -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS kadiwa_sale_items (
  id SERIAL PRIMARY KEY,
  sale_id VARCHAR(30) NOT NULL REFERENCES kadiwa_sales(id) ON DELETE CASCADE,
  inventory_id VARCHAR(30) NOT NULL REFERENCES kadiwa_inventory(id) ON DELETE RESTRICT,
  item_name VARCHAR(200) NOT NULL,
  category VARCHAR(30) NOT NULL,
  unit VARCHAR(40) NOT NULL,
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(14, 2) NOT NULL CHECK (line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kadiwa_sale_items_sale ON kadiwa_sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_kadiwa_sale_items_inventory ON kadiwa_sale_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_kadiwa_sales_created_by ON kadiwa_sales(created_by);
-- Collision-free ids for new sales (S-YYYY-00001) and products (INV-0001),
-- replacing the previous timestamp-based ids.
CREATE SEQUENCE IF NOT EXISTS kadiwa_sale_seq;
CREATE SEQUENCE IF NOT EXISTS kadiwa_inventory_seq;

-- 10. Notifications, announcements, legal documents -----------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  severity VARCHAR(20) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'error')),
  link VARCHAR(255),
  entity_type VARCHAR(80),
  entity_id VARCHAR(100),
  dedupe_key VARCHAR(200),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  audience VARCHAR(30) NOT NULL DEFAULT 'All Members' CHECK (audience IN ('All Members', 'Admins Only')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS legal_documents (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(80) NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  stored_file_path TEXT NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL CHECK (file_size > 0),
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_legal_documents_created ON legal_documents(created_at DESC) WHERE deleted_at IS NULL;

-- 10b. Savings deposits ---------------------------------------------------------
-- The Savings page describes itself as "member savings deposits only; share
-- capital is tracked separately", so savings get their own ledger instead of
-- being mixed into share_contributions (which carries the PHP 20,000 cap).
CREATE TABLE IF NOT EXISTS savings_transactions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  transaction_type VARCHAR(20) NOT NULL DEFAULT 'deposit' CHECK (transaction_type IN ('deposit')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  transaction_date DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::date),
  payment_method VARCHAR(50),
  reference_number VARCHAR(100),
  notes TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_savings_transactions_member ON savings_transactions(member_id, transaction_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_savings_transactions_date ON savings_transactions(transaction_date DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_transactions_reference
  ON savings_transactions(member_id, LOWER(reference_number)) WHERE reference_number IS NOT NULL;

-- 11. Date defaults in Asia/Manila ---------------------------------------------
ALTER TABLE loans ALTER COLUMN date_approved SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::date);
ALTER TABLE loan_payments ALTER COLUMN payment_date SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::date);
ALTER TABLE share_contributions ALTER COLUMN contribution_date SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::date);
ALTER TABLE members ALTER COLUMN membership_date SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Manila')::date);

-- 12. Indexes for foreign keys and API query patterns ----------------------------
CREATE INDEX IF NOT EXISTS idx_loan_requests_member ON loan_requests(member_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_payments_date ON loan_payments(payment_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_loans_created ON loans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_contributions_date ON share_contributions(contribution_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_rental_requests_machinery ON rental_requests(machinery_id);
CREATE INDEX IF NOT EXISTS idx_machinery_operations_machinery_dates ON machinery_operations(machinery_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_machinery_operations_member ON machinery_operations(member_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_user ON audit_logs(target_user_id);

-- 13. Live-update NOTIFY triggers (payload = table, op and owning ids only) -------
CREATE OR REPLACE FUNCTION acifac_emit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  rec JSONB;
  payload JSONB;
  member_ref BIGINT;
BEGIN
  rec := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  payload := jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP);

  IF TG_TABLE_NAME = 'loan_payments' THEN
    SELECT member_id INTO member_ref FROM loans WHERE id = (rec ->> 'loan_id')::int;
    payload := payload || jsonb_build_object('memberId', member_ref);
  ELSIF TG_NARGS > 0 AND TG_ARGV[0] <> '' THEN
    payload := payload || jsonb_build_object('memberId', rec -> TG_ARGV[0]);
  END IF;

  IF TG_NARGS > 1 THEN
    payload := payload || jsonb_build_object('userId', rec -> TG_ARGV[1]);
  END IF;

  PERFORM pg_notify('acifac_events', payload::text);
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    ARRAY['members', 'id', ''],
    ARRAY['share_contributions', 'member_id', ''],
    ARRAY['savings_transactions', 'member_id', ''],
    ARRAY['loans', 'member_id', ''],
    ARRAY['loan_requests', 'member_id', ''],
    ARRAY['loan_payments', '', ''],
    ARRAY['rental_requests', 'member_id', ''],
    ARRAY['machinery_operations', 'member_id', ''],
    ARRAY['machinery', '', ''],
    ARRAY['kadiwa_inventory', '', ''],
    ARRAY['kadiwa_sales', '', ''],
    ARRAY['announcements', '', ''],
    ARRAY['notifications', '', 'user_id'],
    ARRAY['document_scans', '', ''],
    ARRAY['users', '', '']
  ];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_acifac_emit_change ON %I', spec[1]);
    IF spec[3] <> '' THEN
      EXECUTE format('CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION acifac_emit_change(%L, %L)', spec[1], spec[2], spec[3]);
    ELSE
      EXECUTE format('CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION acifac_emit_change(%L)', spec[1], spec[2]);
    END IF;
  END LOOP;
END $$;

-- 4. Row level security and PostgREST roles ---------------------------------------
-- The backend connects as the database owner and is unaffected. anon/authenticated
-- (Supabase Data API) get no access to application data.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'members', 'users', 'sessions', 'password_reset_tokens', 'audit_logs', 'loan_requests', 'loans',
    'loan_payments', 'loan_installments', 'share_contributions', 'savings_transactions', 'machinery', 'rental_requests',
    'machinery_operations', 'kadiwa_inventory', 'kadiwa_sales', 'kadiwa_sale_items', 'document_scans',
    'notifications', 'announcements', 'legal_documents', 'app_schema_migrations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', tbl);
    END IF;
  END LOOP;
END $$;

-- 14. Private storage buckets ---------------------------------------------------
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public) VALUES
      ('member-documents', 'member-documents', false),
      ('member-photos', 'member-photos', false),
      ('ocr-uploads', 'ocr-uploads', false),
      ('legal-documents', 'legal-documents', false)
    ON CONFLICT (id) DO NOTHING;

    UPDATE storage.buckets SET public = false, file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    WHERE id = 'member-documents';
    UPDATE storage.buckets SET public = false, file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
    WHERE id = 'member-photos';
    UPDATE storage.buckets SET public = false, file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    WHERE id IN ('ocr-uploads', 'legal-documents');
  END IF;
END $$;

-- Record the baseline so `npm run migrate` does not replay older files.
INSERT INTO app_schema_migrations (filename) VALUES
  ('001_auth_schema.sql'), ('002_session_lookup_digest.sql'), ('003_members_management.sql'),
  ('004_member_archiving.sql'), ('005_loans_and_payments.sql'), ('006_machinery_operations.sql'),
  ('007_kadiwa_store.sql'), ('008_document_scans.sql'), ('009_reconcile_loan_interest.sql'),
  ('010_share_contributions.sql'), ('011_agricultural_loan_application_details.sql'),
  ('012_production_alignment.sql')
ON CONFLICT (filename) DO NOTHING;

-- Reversal notes (manual, only if needed):
--   * New tables (loan_installments, kadiwa_sale_items, notifications, announcements,
--     legal_documents, savings_transactions, app_schema_migrations) can be dropped
--     without affecting the pre-existing tables (export their rows first).
--   * New columns are nullable/defaulted and can be dropped individually.
--   * DROP TRIGGER trg_acifac_emit_change ON <table>; DROP FUNCTION acifac_emit_change();
--   * archived_by stays integer: the previous uuid column only ever referenced the
--     unused user_accounts table and held no values.
