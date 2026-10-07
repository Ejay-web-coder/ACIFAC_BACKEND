import { query } from '../config/db.js';
import { SQL_TODAY, TIME_ZONE } from '../config/env.js';
import { centsToString, toCents } from '../utils/money.js';

// The cooperative's net income from its three income-earning modules, each
// already net of its own expenses, between from and to (YYYY-MM-DD, inclusive;
// null means no limit):
//   Kadiwa Store       net sales (sales less the expenses entered with each sale)
//   Machinery          rental fees of rentals that have started (a rental also
//                      recorded as a service counts once, as the service) + service
//                      fees collected + other income - machinery expenses, as in
//                      the PhilMech cash flow
//   Loans & Payments   interest collected (principal repaid is not income)
const NET_INCOME_SQL = `
  SELECT
    (SELECT COALESCE(SUM(net_sales), 0) FROM kadiwa_sales
      WHERE status = 'completed'
        AND ($1::date IS NULL OR (created_at AT TIME ZONE '${TIME_ZONE}')::date >= $1::date)
        AND ($2::date IS NULL OR (created_at AT TIME ZONE '${TIME_ZONE}')::date <= $2::date)) AS kadiwa,
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
      WHERE ($1::date IS NULL OR payment_date >= $1::date) AND ($2::date IS NULL OR payment_date <= $2::date)) AS "loanInterest"`;

/** Net income and its parts in centavos. */
export async function netIncomeCents({ from = null, to = null } = {}, db = { query }) {
  const row = (await db.query(NET_INCOME_SQL, [from, to])).rows[0];
  const kadiwa = toCents(row.kadiwa);
  const machinery = toCents(row.rentalFees) + toCents(row.serviceFees) + toCents(row.otherIncome) - toCents(row.expenses);
  const loans = toCents(row.loanInterest);
  return { total: kadiwa + machinery + loans, parts: { kadiwa, machinery, loans } };
}

export const centsToNumber = (cents) => Number(centsToString(cents));
