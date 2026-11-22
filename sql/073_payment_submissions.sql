-- Online payments by GCash or Maya (November 2026), without a payment gateway.
-- A member sends money to the cooperative's GCash or Maya account, uploads the
-- screenshot of the payment with its reference number, and the office checks
-- the cooperative's own GCash or Maya app before recording it:
--   payment_channels      the cooperative's GCash and Maya accounts (name,
--                         number, QR code), set by the office in Settings
--   payment_submissions   one row per payment a member reports: what it pays
--                         (a loan, dues or a savings deposit), the amount, the
--                         channel and reference number, the screenshot, what
--                         AI read on it and the problems found, and the
--                         office's decision (pending, approved, rejected)
--   loan_payments         the payment method and reference number of a loan
--                         payment (NULL for payments recorded at the office
--                         before; an approved online payment has its channel
--                         and reference number)
-- A reference number is used once per channel: a second submission with it
-- is refused while the first is pending or approved (a rejected one may be
-- sent again, e.g. with a clearer screenshot).
--
-- Additive only. Reversal (manual; removes every submission and the settings):
--   DROP TABLE payment_submissions; DROP TABLE payment_channels;
--   ALTER TABLE loan_payments DROP COLUMN payment_method, DROP COLUMN reference_number;

CREATE TABLE IF NOT EXISTS payment_channels (
  channel VARCHAR(10) PRIMARY KEY CHECK (channel IN ('GCash', 'Maya')),
  account_name VARCHAR(150) NOT NULL DEFAULT '',
  -- The mobile number of the account, 09XXXXXXXXX.
  account_number VARCHAR(11) NOT NULL DEFAULT '' CHECK (account_number = '' OR account_number ~ '^09[0-9]{9}$'),
  qr_reference TEXT,
  qr_mime_type VARCHAR(50),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_channels_enabled_complete CHECK (NOT enabled OR (btrim(account_name) <> '' AND account_number <> ''))
);
INSERT INTO payment_channels (channel) VALUES ('GCash'), ('Maya') ON CONFLICT (channel) DO NOTHING;

COMMENT ON TABLE payment_channels IS
  'Current. The cooperative''s GCash and Maya accounts members pay into (Pay online); members see only the enabled ones.';

CREATE TABLE IF NOT EXISTS payment_submissions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purpose VARCHAR(10) NOT NULL CHECK (purpose IN ('loan', 'dues', 'savings')),
  loan_id INTEGER REFERENCES loans(id) ON DELETE RESTRICT,
  due_ids INTEGER[] NOT NULL DEFAULT '{}',
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  channel VARCHAR(10) NOT NULL CHECK (channel IN ('GCash', 'Maya')),
  -- Letters and digits only, upper case (spaces are taken out).
  reference_number VARCHAR(40) NOT NULL CHECK (reference_number ~ '^[A-Z0-9]{6,40}$'),
  paid_on DATE NOT NULL,
  proof_reference TEXT NOT NULL,
  proof_mime_type VARCHAR(50) NOT NULL,
  proof_sha256 CHAR(64) NOT NULL,
  -- What AI read on the screenshot ({ error } when it could not), and the problems found then.
  ai_reading JSONB,
  flags JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  -- What approving recorded.
  loan_payment_id INTEGER REFERENCES loan_payments(id) ON DELETE SET NULL,
  dues_payment_id INTEGER REFERENCES member_dues_payments(id) ON DELETE SET NULL,
  savings_transaction_id INTEGER REFERENCES savings_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_submissions_loan_target CHECK ((purpose = 'loan') = (loan_id IS NOT NULL)),
  CONSTRAINT payment_submissions_dues_target CHECK ((purpose = 'dues') = (cardinality(due_ids) > 0)),
  CONSTRAINT payment_submissions_reviewed CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CONSTRAINT payment_submissions_reject_explained CHECK (status <> 'rejected' OR btrim(COALESCE(review_notes, '')) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_submissions_reference_once ON payment_submissions(channel, reference_number) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_payment_submissions_status ON payment_submissions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_submissions_member ON payment_submissions(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_submissions_proof ON payment_submissions(proof_sha256);

COMMENT ON TABLE payment_submissions IS
  'Current. Payments members made by GCash or Maya and reported with a screenshot (Pay online); recorded as a loan payment, dues payment or savings deposit only when the office approves, after checking the money arrived.';

ALTER TABLE loan_payments
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50),
  ADD COLUMN IF NOT EXISTS reference_number VARCHAR(100);
COMMENT ON COLUMN loan_payments.payment_method IS
  'Current. GCash or Maya for an approved online payment (payment_submissions); NULL for a payment recorded at the office.';

-- Live updates (submissions: the member's own and the office; channels: the office) and
-- row level security, as for every other table (see 012).
DO $$
BEGIN
  DROP TRIGGER IF EXISTS trg_acifac_emit_change ON payment_submissions;
  CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON payment_submissions FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('member_id');
  DROP TRIGGER IF EXISTS trg_acifac_emit_change ON payment_channels;
  CREATE TRIGGER trg_acifac_emit_change AFTER INSERT OR UPDATE OR DELETE ON payment_channels FOR EACH ROW EXECUTE FUNCTION acifac_emit_change('');
  ALTER TABLE payment_submissions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE payment_channels ENABLE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE payment_submissions, payment_channels FROM anon, authenticated;
    REVOKE ALL ON SEQUENCE payment_submissions_id_seq FROM anon, authenticated;
  END IF;
END $$;
