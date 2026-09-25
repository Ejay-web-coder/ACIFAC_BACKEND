-- Details collected by the Add Member form that have no column of their own:
-- mother's name, children, income sources and membership information
-- (type, separation date, B.O.D. resolution, fees, OR number, paid-up capital).
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS additional_info JSONB NOT NULL DEFAULT '{}'::jsonb;
