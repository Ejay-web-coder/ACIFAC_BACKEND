import { query } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { centsToString, toCents } from '../utils/money.js';

// The cooperative's net income from its three income-earning modules, each
// already net of its own expenses, between from and to (YYYY-MM-DD, inclusive;
// null means no limit):
//   Kadiwa Store       net sales (sales less the expenses entered with each sale)
//   Machinery          rental fees of rentals that have started (a rental also
//                      recorded as a service counts once, as the service) + service
//                      fees collected + other income - machinery expenses, as in
//                      the PhilMech cash flow
//   Loans & Payments   interest and late penalties collected (principal repaid
//                      is not income)
//   Others             membership fees written on the members' forms (paid,
//                      dated by the membership date), absence fines and
//                      transfer fees collected under Dues, and the other
//                      income the office records (donations, grants, ...)
// A membership fee is kept as text on the form: only a plain amount ("300",
// "₱1,000.00") counts.
const NET_INCOME_SQL = `
  SELECT
    (SELECT COALESCE(SUM(net_sales), 0) FROM kadiwa_sales
      WHERE status = 'completed'
        AND ($1::date IS NULL OR sale_date >= $1::date)
        AND ($2::date IS NULL OR sale_date <= $2::date)) AS kadiwa,
    (SELECT COALESCE(SUM(mo.rental_fee), 0) FROM machinery_operations mo
      WHERE mo.start_date <= ${SQL_TODAY}
        AND ($1::date IS NULL OR mo.start_date >= $1::date) AND ($2::date IS NULL OR mo.start_date <= $2::date)
        AND NOT EXISTS (SELECT 1 FROM machinery_services s WHERE s.rental_request_id = mo.rental_request_id)) AS "rentalFees",
    (SELECT COALESCE(SUM(amount), 0) FROM machinery_service_payments
      WHERE ($1::date IS NULL OR payment_date >= $1::date) AND ($2::date IS NULL OR payment_date <= $2::date)) AS "serviceFees",
    (SELECT COALESCE(SUM(other_income), 0) FROM machinery_period_balances
      WHERE ($1::date IS NULL OR year >= EXTRACT(YEAR FROM $1::date)) AND ($2::date IS NULL OR year <= EXTRACT(YEAR FROM $2::date))) AS "otherIncome",
    (SELECT COALESCE(SUM(amount), 0) FROM machinery_expenses
      WHERE ($1::date IS NULL OR expense_date >= $1::date) AND ($2::date IS NULL OR expense_date <= $2::date)) AS expenses,
    (SELECT COALESCE(SUM(interest_paid), 0) FROM loan_payments
      WHERE ($1::date IS NULL OR payment_date >= $1::date) AND ($2::date IS NULL OR payment_date <= $2::date)) AS "loanInterest",
    (SELECT COALESCE(SUM(penalty_paid), 0) FROM loan_payments
      WHERE ($1::date IS NULL OR payment_date >= $1::date) AND ($2::date IS NULL OR payment_date <= $2::date)) AS "loanPenalties",
    (SELECT COALESCE(SUM(CASE WHEN fee.text ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN fee.text::numeric ELSE 0 END), 0)
      FROM members m CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(m.additional_info ->> 'membershipFee', ''), '[^0-9.]', '', 'g') AS text) fee
      WHERE COALESCE(m.additional_info ->> 'paymentOfMembershipFee', '') <> 'No'
        AND ($1::date IS NULL OR m.membership_date >= $1::date) AND ($2::date IS NULL OR m.membership_date <= $2::date)) AS "membershipFees",
    (SELECT COALESCE(SUM(d.amount), 0) FROM member_dues d JOIN member_dues_payments p ON p.id = d.payment_id
      WHERE d.kind IN ('absence_fine', 'transfer_fee')
        AND ($1::date IS NULL OR p.payment_date >= $1::date) AND ($2::date IS NULL OR p.payment_date <= $2::date)) AS "duesFines",
    (SELECT COALESCE(SUM(amount), 0) FROM other_income
      WHERE ($1::date IS NULL OR received_on >= $1::date) AND ($2::date IS NULL OR received_on <= $2::date)) AS "recordedOther"`;

/**
 * Net income and its parts in centavos; `others` is the Others part by source
 * (membershipFees, duesFines, recorded).
 */
export async function netIncomeCents({ from = null, to = null } = {}, db = { query }) {
  const row = (await db.query(NET_INCOME_SQL, [from, to])).rows[0];
  const kadiwa = toCents(row.kadiwa);
  const machinery = toCents(row.rentalFees) + toCents(row.serviceFees) + toCents(row.otherIncome) - toCents(row.expenses);
  const loans = toCents(row.loanInterest) + toCents(row.loanPenalties);
  const others = { membershipFees: toCents(row.membershipFees), duesFines: toCents(row.duesFines), recorded: toCents(row.recordedOther) };
  const othersTotal = others.membershipFees + others.duesFines + others.recorded;
  return { total: kadiwa + machinery + loans + othersTotal, parts: { kadiwa, machinery, loans, others: othersTotal }, others };
}

export const centsToNumber = (cents) => Number(centsToString(cents));
