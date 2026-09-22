CREATE TABLE IF NOT EXISTS loan_requests (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  member_name VARCHAR(200) NOT NULL,
  loan_type VARCHAR(30) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  term INTEGER NOT NULL CHECK (term > 0),
  purpose TEXT NOT NULL DEFAULT '',
  monthly_income NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (monthly_income >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id SERIAL PRIMARY KEY,
  loan_number VARCHAR(30) UNIQUE NOT NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  member_name VARCHAR(200) NOT NULL,
  loan_type VARCHAR(30) NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  balance NUMERIC(14, 2) NOT NULL CHECK (balance >= 0),
  interest_rate NUMERIC(5, 2) NOT NULL CHECK (interest_rate >= 0),
  term INTEGER NOT NULL CHECK (term > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid', 'overdue')),
  date_approved DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  next_payment_date DATE,
  monthly_payment NUMERIC(14, 2) NOT NULL CHECK (monthly_payment >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loan_payments (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  principal_paid NUMERIC(14, 2) NOT NULL CHECK (principal_paid >= 0),
  interest_paid NUMERIC(14, 2) NOT NULL CHECK (interest_paid >= 0),
  remaining_balance NUMERIC(14, 2) NOT NULL CHECK (remaining_balance >= 0),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_requests_status ON loan_requests(status);
CREATE INDEX IF NOT EXISTS idx_loans_member_id ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan_id ON loan_payments(loan_id);