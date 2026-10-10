-- Rentals for non-members. A rental request and its booking belong either to
-- a member (member_id) or to a non-member known only by name (member_name).
-- Only the cooperative office records non-member rentals; members book theirs
-- in the member portal. Additive: existing rows are members' rentals.
ALTER TABLE rental_requests
  ADD COLUMN IF NOT EXISTS client_category VARCHAR(20) NOT NULL DEFAULT 'member';
ALTER TABLE rental_requests ALTER COLUMN member_id DROP NOT NULL;

ALTER TABLE machinery_operations
  ADD COLUMN IF NOT EXISTS client_category VARCHAR(20) NOT NULL DEFAULT 'member';
ALTER TABLE machinery_operations ALTER COLUMN member_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rental_request_client_valid') THEN
    ALTER TABLE rental_requests ADD CONSTRAINT rental_request_client_valid CHECK (
      (client_category = 'member' AND member_id IS NOT NULL)
      OR (client_category = 'non_member' AND member_id IS NULL AND btrim(member_name) <> '')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machinery_operation_client_valid') THEN
    ALTER TABLE machinery_operations ADD CONSTRAINT machinery_operation_client_valid CHECK (
      (client_category = 'member' AND member_id IS NOT NULL)
      OR (client_category = 'non_member' AND member_id IS NULL AND btrim(member_name) <> '')
    );
  END IF;
END $$;

COMMENT ON COLUMN rental_requests.client_category IS
  'member: member_id is the member who rents. non_member: someone outside the cooperative, recorded by the office with only a name (member_name); member_id is NULL.';
COMMENT ON COLUMN machinery_operations.client_category IS
  'Copied from the rental request: member (member_id set) or non_member (only member_name).';

-- Reversal (manual, only if needed; first delete or reassign non-member rows):
--   ALTER TABLE rental_requests DROP CONSTRAINT rental_request_client_valid, DROP COLUMN client_category,
--     ALTER COLUMN member_id SET NOT NULL;
--   ALTER TABLE machinery_operations DROP CONSTRAINT machinery_operation_client_valid, DROP COLUMN client_category,
--     ALTER COLUMN member_id SET NOT NULL;
