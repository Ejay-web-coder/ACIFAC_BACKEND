-- Why a machinery rental request was declined (November 2026). The office
-- gives a reason when it declines a request; the member is told it by email,
-- text message and in-app notification, and sees it beside the request under
-- Rental Booking. Same name as loan_requests.review_notes.
--
-- Additive only: requests declined before this have no reason (NULL), and no
-- existing record changes. Reversal (manual):
--   ALTER TABLE rental_requests DROP COLUMN review_notes;
ALTER TABLE rental_requests ADD COLUMN IF NOT EXISTS review_notes TEXT;

COMMENT ON COLUMN rental_requests.review_notes IS
  'Current. The reason the office gave when it declined the request (required since November 2026); NULL for requests that were approved, are pending, or were declined before reasons were asked for.';
