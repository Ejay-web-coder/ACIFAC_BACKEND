-- What the cooperative paid for a machine, for the return on investment per
-- machine in Analytics. Optional: NULL when it has not been entered, 0 for a
-- machine received as a grant (no money of the cooperative to recover).
-- Additive only.
ALTER TABLE machinery
  ADD COLUMN IF NOT EXISTS purchase_cost NUMERIC(12, 2)
    CONSTRAINT machinery_purchase_cost_valid CHECK (purchase_cost >= 0);

COMMENT ON COLUMN machinery.purchase_cost IS
  'What the cooperative paid for the machine (PHP), for the return on investment in Analytics. NULL = not entered; 0 = received as a grant.';

-- Reversal (manual, only if needed):
--   ALTER TABLE machinery DROP COLUMN purchase_cost;
