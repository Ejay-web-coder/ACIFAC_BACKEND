ALTER TABLE members
  ADD COLUMN IF NOT EXISTS suffix VARCHAR(20),
  ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS civil_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS education VARCHAR(50),
  ADD COLUMN IF NOT EXISTS id_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS id_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS rsbsa_no VARCHAR(100),
  ADD COLUMN IF NOT EXISTS livelihood VARCHAR(255),
  ADD COLUMN IF NOT EXISTS farm_area_ha NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS corn_area_ha NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS palay_area_ha NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS yearly_income NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS spouse_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS spouse_age INTEGER,
  ADD COLUMN IF NOT EXISTS spouse_contact VARCHAR(30),
  ADD COLUMN IF NOT EXISTS children TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(255),
  ADD COLUMN IF NOT EXISTS id_document_path TEXT,
  ADD COLUMN IF NOT EXISTS id_document_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS id_document_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS id_document_size BIGINT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS barangay VARCHAR(150),
  ADD COLUMN IF NOT EXISTS municipality VARCHAR(150),
  ADD COLUMN IF NOT EXISTS province VARCHAR(150),
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS gender VARCHAR(30),
  ADD COLUMN IF NOT EXISTS membership_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS share_capital NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS profile_photo TEXT;

UPDATE members
SET membership_date = COALESCE(membership_date, created_at::date),
    status = COALESCE(status, 'active'),
    share_capital = COALESCE(share_capital, 0)
WHERE membership_date IS NULL OR status IS NULL OR share_capital IS NULL;

ALTER TABLE members
  ALTER COLUMN children TYPE TEXT USING children::text;

ALTER TABLE members
  DROP CONSTRAINT IF EXISTS members_status_check;

ALTER TABLE members
  ADD CONSTRAINT members_status_check CHECK (status IN ('active', 'inactive', 'suspended', 'archived'));

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_membership_date ON members(membership_date);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(last_name, first_name);

ALTER TABLE members
  DROP CONSTRAINT IF EXISTS members_non_negative_amounts_check;

ALTER TABLE members
  ADD CONSTRAINT members_non_negative_amounts_check CHECK (
    COALESCE(farm_area_ha, 0) >= 0 AND COALESCE(corn_area_ha, 0) >= 0 AND
    COALESCE(palay_area_ha, 0) >= 0 AND COALESCE(yearly_income, 0) >= 0 AND
    share_capital >= 0
  );