import { query, withTransaction } from '../config/db.js';
import { keepAlive } from '../utils/background.js';
import { emailNotifiedUsers } from './memberEmails.js';
import { loanReminderEmail } from './emailTemplates.js';
import { flushSmsOutbox, loanReminderSms, queueSmsForUsers } from './smsService.js';
import { SQL_TODAY } from '../config/env.js';
import { centsToString, toCents } from '../utils/money.js';
import { paymentHours } from './officeHours.js';

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
// Installments fall due monthly from the approval date; a due date on a day
// the office does not receive payments (a weekend) moves to the next day it
// does. The loan's due date is its last installment's.
export async function createInstallments(client, loanId) {
  const loan = (await client.query(
    `SELECT term, date_approved,
            COALESCE(total_repayment, ROUND(amount + ROUND(amount * interest_rate / 100, 2), 2)) AS total,
            COALESCE(calculated_interest, ROUND(amount * interest_rate / 100, 2)) AS interest
     FROM loans WHERE id = $1`,
    [loanId]
  )).rows[0];
  if (loan) await insertSchedule(client, loanId, { total: loan.total, interest: loan.interest, term: loan.term, start: loan.date_approved, firstNumber: 1 });
}

// Adds `term` monthly installments numbered from firstNumber, the first due
// one month after `start`, sharing `total` (of which `interest` is interest)
// as described above, and makes the loan's due date its last installment's.
async function insertSchedule(client, loanId, { total, interest, term, start, firstNumber }) {
  await client.query(
    `WITH base AS (
       SELECT $3::numeric AS total, $4::numeric AS interest, $5::int AS term, $6::date AS start
     ), parts AS (
       SELECT b.*, n,
              CASE WHEN n < b.term THEN ROUND(b.total / b.term, 2) ELSE b.total - ROUND(b.total / b.term, 2) * (b.term - 1) END AS amount_due,
              CASE WHEN n < b.term THEN FLOOR(b.interest * 100 / b.term) / 100 ELSE b.interest - (FLOOR(b.interest * 100 / b.term) / 100) * (b.term - 1) END AS interest_due
       FROM base b CROSS JOIN LATERAL generate_series(1, b.term) AS n
     )
     INSERT INTO loan_installments (loan_id, installment_number, due_date, amount_due, principal_due, interest_due)
     SELECT $1, $7::int + n - 1, due.day, amount_due, GREATEST(amount_due - interest_due, 0), LEAST(interest_due, amount_due)
     FROM parts
     CROSS JOIN LATERAL (
       SELECT ((start + make_interval(months => n))::date + k) AS day
       FROM generate_series(0, 6) AS k
       WHERE EXTRACT(ISODOW FROM (start + make_interval(months => n))::date + k)::int = ANY($2::int[])
       ORDER BY k LIMIT 1
     ) due
     ON CONFLICT (loan_id, installment_number) DO NOTHING`,
    [loanId, paymentHours().days, total, interest, term, start, firstNumber]
  );
  await client.query(
    `UPDATE loans SET due_date = last.due_date FROM (SELECT MAX(due_date) AS due_date FROM loan_installments WHERE loan_id = $1 AND superseded_by IS NULL) last
     WHERE loans.id = $1 AND last.due_date IS NOT NULL AND loans.due_date IS DISTINCT FROM last.due_date`,
    [loanId]
  );
}

// Restructures an open loan in place, inside the caller's transaction with the
// loan row locked and its state just recomputed. What is still owed, the open
// part of every installment not yet paid, is carried into `term` new monthly
// installments from restructuredOn, plus interestRate% of it (flat, once). The
// open installments are marked as replaced (superseded_by): their unpaid
// interest stays interest and their unpaid principal stays principal, so the
// payments that follow split the same way. The loan keeps its number, payments
// and original amount and term; its total, interest, monthly payment and due
// date change. Returns the restructuring row.
export async function restructureLoan(client, loanId, { term, interestRate, reason, restructuredOn, userId }) {
  const open = (await client.query(
    `SELECT COALESCE(SUM(principal_due - principal_paid), 0) AS principal,
            COALESCE(SUM(interest_due - interest_paid), 0) AS interest,
            COALESCE(SUM(amount_due - amount_paid) FILTER (WHERE due_date < $2::date), 0) AS overdue_amount,
            COUNT(*) FILTER (WHERE due_date < $2::date)::int AS overdue_installments,
            (SELECT MAX(installment_number) FROM loan_installments WHERE loan_id = $1) AS last_number,
            (SELECT balance FROM loans WHERE id = $1) AS balance,
            (SELECT due_date FROM loans WHERE id = $1) AS due_date
     FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due AND superseded_by IS NULL`,
    [loanId, restructuredOn]
  )).rows[0];
  const principalCents = toCents(open.principal);
  const interestCents = toCents(open.interest);
  if (principalCents + interestCents <= 0) throw new Error(`Loan ${loanId} has nothing left to restructure.`);
  if (principalCents + interestCents !== toCents(open.balance)) throw new Error(`Installment schedule does not match balance for loan ${loanId}.`);

  const restructuring = (await client.query(
    `WITH figures AS (
       SELECT $4::numeric AS principal, $5::numeric AS interest, $4::numeric + $5::numeric AS carried,
              ROUND(($4::numeric + $5::numeric) * $8::numeric / 100, 2) AS added
     )
     INSERT INTO loan_restructurings (loan_id, restructured_on, reason, balance_carried, principal_carried, interest_carried, overdue_amount, overdue_installments,
                                      interest_rate, added_interest, new_term, new_monthly_payment, previous_due_date, new_due_date, first_installment_number, recorded_by)
     SELECT $1, $2::date, $3, carried, principal, interest, $6::numeric, $7::int, $8::numeric, added, $9::int, ROUND((carried + added) / $9::int, 2), $10::date, $10::date, $11::int, $12::int
     FROM figures
     RETURNING *`,
    [loanId, restructuredOn, reason, centsToString(principalCents), centsToString(interestCents), open.overdue_amount, open.overdue_installments,
      interestRate, term, open.due_date, Number(open.last_number) + 1, userId]
  )).rows[0];

  await client.query(
    'UPDATE loan_installments SET superseded_by = $2, updated_at = NOW() WHERE loan_id = $1 AND amount_paid < amount_due AND superseded_by IS NULL',
    [loanId, restructuring.id]
  );
  const addedCents = toCents(restructuring.added_interest);
  await insertSchedule(client, loanId, {
    total: centsToString(principalCents + interestCents + addedCents), interest: centsToString(interestCents + addedCents),
    term, start: restructuredOn, firstNumber: restructuring.first_installment_number,
  });
  await client.query(
    `UPDATE loans
     SET total_repayment = COALESCE(total_repayment, ROUND(amount + ROUND(amount * interest_rate / 100, 2), 2)) + $2::numeric,
         calculated_interest = COALESCE(calculated_interest, ROUND(amount * interest_rate / 100, 2)) + $2::numeric,
         monthly_payment = $3::numeric, updated_at = NOW()
     WHERE id = $1`,
    [loanId, restructuring.added_interest, restructuring.new_monthly_payment]
  );
  return (await client.query(
    `UPDATE loan_restructurings r SET new_due_date = l.due_date FROM loans l WHERE r.id = $1 AND l.id = r.loan_id RETURNING r.*`,
    [restructuring.id]
  )).rows[0];
}

// Applies a payment to the oldest unpaid installments, interest portion first
// (the same order the previous implementation used). Works in centavos.
// Installments replaced by a restructuring are no longer due (see restructureLoan).
export async function allocatePayment(client, loanId, amountCents, paymentDate) {
  const installments = await client.query(
    `SELECT id, amount_due, amount_paid, interest_due, interest_paid, principal_due, principal_paid
     FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due AND superseded_by IS NULL
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
              (SELECT MIN(i.due_date) FROM loan_installments i WHERE i.loan_id = l.id AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL) AS next_due,
              EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL AND i.due_date < ${SQL_TODAY}) AS overdue
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
  keepAlive(refreshLoanStatuses().catch((error) => console.error('Loan status refresh failed:', error instanceof Error ? error.message : error)));
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
         FROM loans l JOIN loan_installments i ON i.loan_id = l.id AND i.superseded_by IS NULL
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
    const dueSoon = await query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
       SELECT u.id, 'payment_due', 'Loan payment due soon',
              format('Installment %s of loan %s (%s) is due on %s.', i.installment_number, l.loan_number, ${money}, to_char(i.due_date, 'FMMonth DD, YYYY')),
              'warning', '/loan-status', 'loan', l.id::text, 'installment-due-' || i.id
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id AND l.status <> 'paid'
       JOIN users u ON u.member_id = l.member_id AND u.account_status = 'ACTIVE'
       WHERE i.amount_paid < i.amount_due AND i.superseded_by IS NULL AND i.due_date BETWEEN ${SQL_TODAY} AND ${SQL_TODAY} + 3
         AND COALESCE((u.notification_preferences ->> 'loanReminders')::boolean, true)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING user_id, title, message`
    );
    // Member: installment overdue.
    const overdue = await query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
       SELECT u.id, 'payment_overdue', 'Loan payment overdue',
              format('Installment %s of loan %s (%s) was due on %s and is now overdue.', i.installment_number, l.loan_number, ${money}, to_char(i.due_date, 'FMMonth DD, YYYY')),
              'error', '/loan-status', 'loan', l.id::text, 'installment-overdue-' || i.id
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id AND l.status <> 'paid'
       JOIN users u ON u.member_id = l.member_id AND u.account_status = 'ACTIVE'
       WHERE i.amount_paid < i.amount_due AND i.superseded_by IS NULL AND i.due_date < ${SQL_TODAY}
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING user_id, title, message`
    );
    // Each reminder is created once per installment (dedupe key), so only the
    // new ones returned here are emailed and texted. Texts are queued; the
    // flush sends them now if it is daytime, else on a later refresh.
    await emailNotifiedUsers([...dueSoon.rows, ...overdue.rows], loanReminderEmail);
    await queueSmsForUsers([...dueSoon.rows, ...overdue.rows], loanReminderSms);
    void flushSmsOutbox();
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
         AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL AND i.due_date < ${SQL_TODAY}
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
    );
  })().catch((error) => {
    console.error('Loan status refresh failed:', error.message);
  });
  return refreshing;
}
