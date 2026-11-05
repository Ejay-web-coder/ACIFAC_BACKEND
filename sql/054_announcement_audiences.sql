-- Announcement audiences: All (everyone with an account), Members Only,
-- Admins Only or Vendors Only (Kadiwa store vendors). "All Members" was
-- already given to every account, so it becomes "All".
DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN SELECT conname FROM pg_constraint WHERE conrelid = 'announcements'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%audience%' LOOP
    EXECUTE format('ALTER TABLE announcements DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;
UPDATE announcements SET audience = 'All' WHERE audience = 'All Members';
ALTER TABLE announcements ALTER COLUMN audience SET DEFAULT 'All';
ALTER TABLE announcements ADD CONSTRAINT announcements_audience_check CHECK (audience IN ('All', 'Members Only', 'Admins Only', 'Vendors Only'));
