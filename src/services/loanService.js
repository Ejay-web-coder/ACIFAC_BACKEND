import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { centsToString, toCents } from '../utils/money.js';

// ACIFAC agricultural loan policy (unchanged from the existing system):
//   * maximum loan = farm area (ha) x PHP 50,000
//   * interest = 2.5% of the principal, charged once for the whole term (flat)
//   * total repayment = principal + interest
//   * repaid in `term` equal monthly installments, the first due one month
//     after approval; the last installment absorbs centavo rounding
//     (interest is split with FLOOR so no installment can go negative).
// Requests submitted before migration 011 stored no rate; those keep the
// historical 8% rate they were quoted.
export const LOAN_POLICY = Object.freeze({
  maxLoanPerHectare: '50000',
  interestRate: '2.5',
  legacyInterestRate: '8',
  minTerm: 1,
  maxTerm: 60,
  interestMethod: 'flat',
  scheduleFrequency: 'monthly',
});

function runner(db) {
  return db && typeof db.query === 'function' ? db.query.bind(db) : query;
}

// All money arithmetic happens in PostgreSQL NUMERIC.
export async function calculateLoanFinancials(db, { farmArea, amount, term, interestRate = LOAN_POLICY.interestRate }) {
  const result = await runner(db)(
    `SELECT ROUND($1::numeric * $2::numeric, 2) AS maximum_eligible_amount,
            ROUND($3::numeric * ($4::numeric / 100), 2) AS calculated_interest,
            ROUND($3::numeric + ROUND($3::numeric * ($4::numeric / 100), 2), 2) AS total_repayment,
            ROUND(ROUND($3::numeric + ROUND($3::numeric * ($4::numeric / 100), 2), 2) / $5::numeric, 2) AS monthly_payment`,
    [farmArea ?? 0, LOAN_POLICY.maxLoanPerHectare, amount, interestRate, term]
  );
  return result.rows[0];
}

// Creates the installment schedule for a loan (no-op if it already exists).
export async function createInstallments(client, loanId) {
  await client.query(
    `WITH base AS (
       SELECT l.id, l.term, l.date_approved,
              COALESCE(l.total_repayment, ROUND(l.amount + ROUND(l.amount * l.interest_rate / 100, 2), 2)) AS total,
              COALESCE(l.calculated_interest, ROUND(l.amount * l.interest_rate / 100, 2)) AS interest
       FROM loans l WHERE l.id = $1
     ), parts AS (
       SELECT b.*, n,
              CASE WHEN n < b.term THEN ROUND(b.total / b.term, 2) ELSE b.total - ROUND(b.total / b.term, 2) * (b.term - 1) END AS amount_due,
              CASE WHEN n < b.term THEN FLOOR(b.interest * 100 / b.term) / 100 ELSE b.interest - (FLOOR(b.interest * 100 / b.term) / 100) * (b.term - 1) END AS interest_due
       FROM base b CROSS JOIN LATERAL generate_series(1, b.term) AS n
     )
     INSERT INTO loan_installments (loan_id, installment_number, due_date, amount_due, principal_due, interest_due)
     SELECT id, n, (date_approved + make_interval(months => n))::date, amount_due, GREATEST(amount_due - interest_due, 0), LEAST(interest_due, amount_due)
     FROM parts
     ON CONFLICT (loan_id, installment_number) DO NOTHING`,
    [loanId]
  );
}

// Applies a payment to the oldest unpaid installments, interest portion first
// (the same order the previous implementation used). Works in centavos.
export async function allocatePayment(client, loanId, amountCents, paymentDate) {
  const installments = await client.query(
    `SELECT id, amount_due, amount_paid, interest_due, interest_paid, principal_due, principal_paid
     FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due
     ORDER BY installment_number FOR UPDATE`,
    [loanId]
  );
  let remaining = amountCents;
  let interestTotal = 0;
  let principalTotal = 0;
  for (const row of installments.rows) {
    if (remaining <= 0) break;
    const interestOpen = toCents(row.interest_due) - toCents(row.interest_paid);
    const principalOpen = toCents(row.principal_due) - toCents(row.principal_paid);
    const interestPart = Math.min(remaining, Math.max(0, interestOpen));
    remaining -= interestPart;
    const principalPart = Math.min(remaining, Math.max(0, principalOpen));
    remaining -= principalPart;
    if (interestPart + principalPart === 0) continue;
    interestTotal += interestPart;
    principalTotal += principalPart;
    const newPaid = toCents(row.amount_paid) + interestPart + principalPart;
    await client.query(
      `UPDATE loan_installments
       SET amount_paid = $2::numeric, interest_paid = interest_paid + $3::numeric, principal_paid = principal_paid + $4::numeric,
           last_payment_date = $5::date, paid_date = CASE WHEN $2::numeric >= amount_due THEN $5::date ELSE NULL END, updated_at = NOW()
       WHERE id = $1`,
      [row.id, centsToString(newPaid), centsToString(interestPart), centsToString(principalPart), paymentDate]
    );
  }
  return { interestCents: interestTotal, principalCents: principalTotal, unallocatedCents: remaining };
}

// Makes sure a loan (e.g. one created before installments existed) has its
// schedule, and replays already-recorded payments onto it.
export async function ensureInstallments(client, loanId) {
  const existing = await client.query('SELECT COUNT(*)::int AS count FROM loan_installments WHERE loan_id = $1', [loanId]);
  if (existing.rows[0].count > 0) return false;
  await createInstallments(client, loanId);
  const payments = await client.query('SELECT amount, payment_date FROM loan_payments WHERE loan_id = $1 ORDER BY payment_date, id', [loanId]);
  for (const payment of payments.rows) {
    await allocatePayment(client, loanId, toCents(payment.amount), payment.payment_date);
  }
  return true;
}

// Recomputes balance, next payment date and status from the schedule and the
// recorded payments (the database is the source of truth).
export async function recomputeLoanState(client, loanId) {
  const result = await client.query(
    `WITH totals AS (
       SELECT l.id,
              COALESCE(l.total_repayment, ROUND(l.amount + ROUND(l.amount * l.interest_rate / 100, 2), 2)) AS total,
              COALESCE((SELECT SUM(p.amount) FROM loan_payments p WHERE p.loan_id = l.id), 0) AS paid,
              (SELECT MIN(i.due_date) FROM loan_installments i WHERE i.loan_id = l.id AND i.amount_paid < i.amount_due) AS next_due,
              EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id AND i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}) AS overdue
       FROM loans l WHERE l.id = $1
     )
     UPDATE loans l
     SET balance = GREATEST(t.total - t.paid, 0),
         next_payment_date = CASE WHEN t.total - t.paid <= 0 THEN NULL ELSE t.next_due END,
         status = CASE WHEN t.total - t.paid <= 0 THEN 'paid' WHEN t.overdue THEN 'overdue' ELSE 'active' END,
         updated_at = NOW()
     FROM totals t WHERE l.id = t.id
     RETURNING l.id, l.balance, l.status, l.next_payment_date`,
    [loanId]
  );
  return result.rows[0];
}

let lastRefresh = 0;
let refreshing = null;

// Read endpoints use this: statuses are brought up to date at most once a
// minute per server instance, without making the request wait. Changes that
// must be exact (payments, approvals) recompute inside their own transaction,
// and the daily cron refreshes everything at midnight.
export function refreshLoanStatusesInBackground() {
  refreshLoanStatuses().catch((error) => console.error('Loan status refresh failed:', error instanceof Error ? error.message : error));
}

// Updates overdue status for all open loans and creates due/overdue
// notifications (each at most once, via dedupe keys). Throttled so that the
// many read endpoints that call it cost at most one pass per minute.
export async function refreshLoanStatuses({ force = false } = {}) {
  if (!force && Date.now() - lastRefresh < 60000) return refreshing;
  lastRefresh = Date.now();
  refreshing = (async () => {
    const missing = await query(`SELECT l.id FROM loans l WHERE NOT EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id)`);
    for (const row of missing.rows) {
      await withTransaction(async (client) => {
        await client.query('SELECT id FROM loans WHERE id = $1 FOR UPDATE', [row.id]);
        await ensureInstallments(client, row.id);
        await recomputeLoanState(client, row.id);
      });
    }

    await query(
      `WITH state AS (
         SELECT l.id,
                MIN(i.due_date) FILTER (WHERE i.amount_paid < i.amount_due) AS next_due,
                COALESCE(BOOL_OR(i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}), false) AS overdue
         FROM loans l JOIN loan_installments i ON i.loan_id = l.id
         WHERE l.status <> 'paid'
         GROUP BY l.id
       )
       UPDATE loans l
       SET status = CASE WHEN s.overdue THEN 'overdue' ELSE 'active' END, next_payment_date = s.next_due, updated_at = NOW()
       FROM state s
       WHERE l.id = s.id
         AND (l.status IS DISTINCT FROM CASE WHEN s.overdue THEN 'overdue' ELSE 'active' END OR l.next_payment_date IS DISTINCT FROM s.next_due)`
    );

    const money = `'PHP ' || to_char(i.amount_due - i.amount_paid, 'FM999,999,990.00')`;
    // Member: installment due within 3 days (respects the loan reminder preference).
    await query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
       SELECT u.id, 'payment_due', 'Loan payment due soon',
              format('Installment %s of loan %s (%s) is due on %s.', i.installment_number, l.loan_number, ${money}, to_char(i.due_date, 'FMMonth DD, YYYY')),
              'warning', '/loan-status', 'loan', l.id::text, 'installment-due-' || i.id
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id AND l.status <> 'paid'
       JOIN users u ON u.member_id = l.member_id AND u.account_status = 'ACTIVE'
       WHERE i.amount_paid < i.amount_due AND i.due_date BETWEEN ${SQL_TODAY} AND ${SQL_TODAY} + 3
         AND COALESCE((u.notification_preferences ->> 'loanReminders')::boolean, true)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
    );
    // Member: installment overdue.
    await query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
       SELECT u.id, 'payment_overdue', 'Loan payment overdue',
              format('Installment %s of loan %s (%s) was due on %s and is now overdue.', i.installment_number, l.loan_number, ${money}, to_char(i.due_date, 'FMMonth DD, YYYY')),
              'error', '/loan-status', 'loan', l.id::text, 'installment-overdue-' || i.id
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id AND l.status <> 'paid'
       JOIN users u ON u.member_id = l.member_id AND u.account_status = 'ACTIVE'
       WHERE i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
    );
    // Admins: one notification per overdue installment.
    await query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
       SELECT a.id, 'payment_overdue', 'Loan payment overdue',
              format('%s''s loan %s: installment %s (%s) was due on %s.', l.member_name, l.loan_number, i.installment_number, ${money}, to_char(i.due_date, 'FMMonth DD, YYYY')),
              'warning', '/loans', 'loan', l.id::text, 'installment-overdue-' || i.id
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id AND l.status <> 'paid'
       CROSS JOIN users a
       WHERE a.role = 'ADMIN' AND a.account_status = 'ACTIVE'
         AND i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
    );
  })().catch((error) => {
    console.error('Loan status refresh failed:', error.message);
  });
  return refreshing;
}
