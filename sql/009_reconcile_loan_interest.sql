UPDATE loans l
SET balance = GREATEST(
  0,
  ROUND((l.amount * (1 + l.interest_rate / 100)), 2) - COALESCE((
    SELECT SUM(p.amount)
    FROM loan_payments p
    WHERE p.loan_id = l.id
  ), 0)
),
updated_at = NOW()
WHERE l.status <> 'paid';

UPDATE loans l
SET status = CASE
  WHEN balance <= 0 THEN 'paid'
  ELSE status
END
WHERE status <> 'paid';
