-- Who operated the machine on each operation (November 2026). The office
-- enters the operator's name on an approved booking (machinery_operations)
-- and on a service done for a farmer (machinery_services). A name, not a
-- link to a member or user: an operator may be hired from outside the
-- cooperative.
--
-- Additive only: operations recorded before this have no operator (NULL), and
-- no existing record changes. A blank name is stored as NULL.
-- Reversal (manual):
--   ALTER TABLE machinery_operations DROP COLUMN operator_name;
--   ALTER TABLE machinery_services DROP COLUMN operator_name;
ALTER TABLE machinery_operations ADD COLUMN IF NOT EXISTS operator_name VARCHAR(200);
ALTER TABLE machinery_services ADD COLUMN IF NOT EXISTS operator_name VARCHAR(200);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machinery_operation_operator_not_blank') THEN
    ALTER TABLE machinery_operations ADD CONSTRAINT machinery_operation_operator_not_blank
      CHECK (operator_name IS NULL OR btrim(operator_name) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machinery_service_operator_not_blank') THEN
    ALTER TABLE machinery_services ADD CONSTRAINT machinery_service_operator_not_blank
      CHECK (operator_name IS NULL OR btrim(operator_name) <> '');
  END IF;
END $$;

COMMENT ON COLUMN machinery_operations.operator_name IS
  'Current. The name of who operated the machine for this booking, entered by the office; NULL when not entered.';
COMMENT ON COLUMN machinery_services.operator_name IS
  'Current. The name of who operated the machine for this service, entered by the office; NULL when not entered.';
