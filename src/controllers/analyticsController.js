import { query } from '../config/db.js';
import { SQL_TODAY, TIME_ZONE } from '../config/env.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, notFound, parseId } from '../utils/http.js';
import { centsToNumber, netIncomeCents } from '../services/netIncome.js';
import { computeDividend } from '../services/dividends.js';
import { refreshLoanStatusesInBackground } from '../services/loanService.js';
import { signedSavings } from '../services/savingsLedger.js';
import { refreshRentalStatusesInBackground } from './machineryController.js';
import { machineryAnalytics, machineryRecommendations } from '../services/machineryAnalytics.js';
import { adviseOnCredit, creditFacts } from '../services/creditAdvice.js';
import { kadiwaProductAnalytics } from '../services/kadiwaProducts.js';

// A member's share capital is at most PHP 20,000 (SHARE_CAPITAL_LIMIT in
// memberController.js, not imported: the controllers import each other).
const SHARE_CAPITAL_LIMIT = 20000;

// The share capital bands of the admin dashboard, lowest first: min is included, max is
// not (null for the PHP 20,000 maximum itself). The counts and the member
// list of a band both use them.
const SHARE_CAPITAL_BANDS = [
  { key: 'below1k', min: 0, max: 1000 },
  { key: 'from1kTo5k', min: 1000, max: 5000 },
  { key: 'from5kTo15k', min: 5000, max: 15000 },
  { key: 'from15kTo20k', min: 15000, max: SHARE_CAPITAL_LIMIT },
  { key: 'maximum', min: SHARE_CAPITAL_LIMIT, max: null },
];
const inBand = (band) => `total >= ${band.min}${band.max === null ? '' : ` AND total < ${band.max}`}`;
// Each member's whole share capital, as on their member record; terminated
// members left out.
const MEMBER_SHARE_TOTALS = `
  SELECT m.id, COALESCE(SUM(sc.amount), 0) AS total
  FROM members m LEFT JOIN share_contributions sc ON sc.member_id = m.id
  WHERE m.status <> 'archived'
  GROUP BY m.id`;

const toNumber = (value) => Number(value || 0);

function mapRows(rows, numberFields = []) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, numberFields.includes(key) ? toNumber(value) : value])));
}

// Repayment performance is measured per installment that has fallen due
// (due date on or before today):
//   on time  = the installment was fully paid on or before its due date
//   late     = paid after its due date, or still unpaid after it
//   onTimePaymentRate = on-time installments / installments due x 100
// The rating and the loan-capacity recommendation are fixed rules over those
// measured values (documented in METHODOLOGY), not AI-generated scores.
export const METHODOLOGY = {
  onTimePaymentRate: 'Installments fully paid on or before their due date, divided by installments already due, x 100.',
  overdueInstallments: 'Installments past their due date that are not fully paid.',
  repaymentRating: {
    'Insufficient data': 'No installment has fallen due yet.',
    Excellent: 'No overdue installments, on-time rate >= 90%, and at least one fully paid loan.',
    Good: 'No overdue installments and on-time rate >= 75%.',
    Fair: 'On-time rate >= 50%.',
    'Needs Improvement': 'On-time rate below 50%.',
  },
  loanCapacity: 'Rule-based recommendation: Strong/Good require a fully paid loan, on-time rate >= 80% and no overdue installments. It is guidance for the credit committee, not an approval.',
  latePayments: 'Installments already due that were not fully paid on or before their due date, including ones past due when the loan was restructured.',
  restructuredLoans: 'Loans given a new schedule for their remaining balance (Loans & Payments, Restructure).',
};

function repaymentRating(member) {
  if (member.installmentsDue === 0) return 'Insufficient data';
  if (member.overdueInstallments === 0 && member.onTimePaymentRate >= 90 && member.completedLoans >= 1) return 'Excellent';
  if (member.overdueInstallments === 0 && member.onTimePaymentRate >= 75) return 'Good';
  if (member.onTimePaymentRate >= 50) return 'Fair';
  return 'Needs Improvement';
}

function buildLoanRecommendation(member) {
  if (member.installmentsDue === 0) {
    return { assessment: 'Needs Review', recommendation: 'Not enough repayment history yet for a rule-based recommendation.', reasons: [] };
  }
  const reasons = [];
  if (member.onTimePaymentRate >= 90) reasons.push(`On-time rate of ${member.onTimePaymentRate}%`);
  if (member.completedLoans > 0) reasons.push(`${member.completedLoans} loan${member.completedLoans === 1 ? '' : 's'} fully paid`);
  if (member.overdueInstallments === 0) reasons.push('No overdue installments');
  if (member.totalBorrowed > 0 && member.outstandingBalance <= member.totalBorrowed * 0.25) reasons.push('Outstanding balance is at most 25% of amount borrowed');
  if (member.shareCapital > 0) reasons.push(`Share capital of PHP ${member.shareCapital.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`);

  const suitable = member.completedLoans > 0 && member.onTimePaymentRate >= 80 && member.overdueInstallments === 0;
  const assessment = suitable ? (member.onTimePaymentRate >= 90 ? 'Strong' : 'Good') : member.onTimePaymentRate >= 50 ? 'Moderate' : 'Needs Review';
  return {
    assessment,
    recommendation: suitable
      ? 'Rule-based recommendation: repayment history supports considering a higher loan amount, subject to cooperative review.'
      : 'Rule-based recommendation: review this member\'s repayment history and current obligations before considering a higher amount.',
    reasons,
  };
}

// The period of an Analytics request (from and to, YYYY-MM-DD, in the query or
// body); this year up to today by default.
function readPeriod(source = {}) {
  const today = todayDateOnly();
  const from = source.from === undefined ? `${today.slice(0, 4)}-01-01` : String(source.from);
  const to = source.to === undefined ? today : String(source.to);
  if (!isValidDateOnly(from) || !isValidDateOnly(to)) throw badRequest('Analytics dates must be valid YYYY-MM-DD values.');
  if (from > to) throw badRequest('The analytics start date must be before the end date.');
  return { from, to };
}

export async function getAnalytics(req, res) {
  const { from, to } = readPeriod(req.query);

  refreshLoanStatusesInBackground();
  refreshRentalStatusesInBackground();
  const localDate = (column) => `(${column} AT TIME ZONE '${TIME_ZONE}')::date`;

  const [summary, loans, revenue, machinery, sales, memberAnalytics] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM members WHERE status = 'active') AS "activeMembers",
        (SELECT COUNT(*)::int FROM members) AS "totalMembers",
        (SELECT COUNT(*)::int FROM members WHERE status = 'archived') AS "archivedMembers",
        (SELECT COUNT(*)::int FROM members WHERE membership_date BETWEEN $1::date AND $2::date AND status <> 'archived') AS "newMembers",
        (SELECT COALESCE(SUM(sc.amount), 0) FROM share_contributions sc WHERE sc.contribution_date BETWEEN $1::date AND $2::date) AS "shareCapital",
        (SELECT COALESCE(SUM(sc.amount), 0) FROM share_contributions sc) AS "totalShareCapital",
        (SELECT COALESCE(SUM(${signedSavings('st')}), 0) FROM savings_transactions st) AS "totalSavings",
        (SELECT COALESCE(SUM(st.amount), 0) FROM savings_transactions st WHERE st.transaction_type = 'deposit' AND st.transaction_date BETWEEN $1::date AND $2::date) AS "savingsDeposits",
        (SELECT COALESCE(SUM(lp.amount), 0) FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date) AS "loanPayments",
        (SELECT COALESCE(SUM(lp.amount), 0) FROM loan_payments lp) AS "totalLoanPayments",
        (SELECT COALESCE(SUM(lp.interest_paid), 0) FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date) AS "interestCollected",
        (SELECT COALESCE(SUM(mo.rental_fee), 0) FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date) AS "machineryRevenue",
        (SELECT COALESCE(SUM(ks.net_sales), 0) FROM kadiwa_sales ks WHERE ks.sale_date BETWEEN $1::date AND $2::date AND ks.status = 'completed') AS "kadiwaNetSales",
        (SELECT COALESCE(SUM(l.balance), 0) FROM loans l WHERE l.status IN ('active', 'overdue')) AS "outstandingBalance",
        (SELECT COUNT(*)::int FROM loans) AS "totalLoans",
        (SELECT COUNT(*)::int FROM loans WHERE status = 'active') AS "activeLoans",
        (SELECT COUNT(*)::int FROM loans WHERE status = 'paid') AS "completedLoans",
        (SELECT COUNT(*)::int FROM loans WHERE status = 'overdue') AS "overdueLoans",
        (SELECT COUNT(*)::int FROM loan_requests lr WHERE ${localDate('lr.submitted_at')} BETWEEN $1::date AND $2::date) AS "loanApplications",
        (SELECT COUNT(*)::int FROM loan_requests lr WHERE lr.status = 'pending') AS "pendingLoanApplications",
        (SELECT COALESCE(SUM(lr.amount), 0) FROM loan_requests lr WHERE ${localDate('lr.submitted_at')} BETWEEN $1::date AND $2::date) AS "requestedLoanAmount",
        (SELECT COALESCE(SUM(lr.maximum_eligible_amount), 0) FROM loan_requests lr WHERE ${localDate('lr.submitted_at')} BETWEEN $1::date AND $2::date) AS "maximumEligibleAmount",
        (SELECT COALESCE(SUM(lr.total_repayment), 0) FROM loan_requests lr WHERE ${localDate('lr.submitted_at')} BETWEEN $1::date AND $2::date) AS "projectedRepayment"
    `, [from, to]),
    // Loans disbursed month by month, every month including those without a
    // loan, with the change from the month before. A period of a year or more
    // shows its own months; a shorter one shows the 12 months up to its last
    // month, so there is a trend to compare. Never past the current month.
    query(`
      WITH bounds AS (
        SELECT DATE_TRUNC('month', $1::date)::date AS first_month,
               DATE_TRUNC('month', LEAST($2::date, ${SQL_TODAY}))::date AS last_month,
               DATE_TRUNC('month', $2::date)::date >= (DATE_TRUNC('month', $1::date) + INTERVAL '11 months')::date AS whole_year
      ), span AS (
        SELECT CASE WHEN whole_year THEN first_month ELSE (last_month - INTERVAL '11 months')::date END AS start_month, last_month
        FROM bounds WHERE last_month >= first_month
      ), months AS (
        -- One month more at the start: the first month's change is measured from it.
        SELECT generate_series((s.start_month - INTERVAL '1 month')::date, s.last_month, INTERVAL '1 month')::date AS month, s.start_month FROM span s
      ), totals AS (
        SELECT m.month, m.start_month, COALESCE(SUM(l.amount), 0) AS amount, COUNT(l.id)::int AS count
        FROM months m LEFT JOIN loans l ON l.date_approved >= m.month AND l.date_approved < (m.month + INTERVAL '1 month')::date
        GROUP BY m.month, m.start_month
      ), compared AS (
        SELECT month, start_month, amount, count, LAG(amount) OVER (ORDER BY month) AS previous FROM totals
      )
      SELECT TO_CHAR(month, 'Mon YYYY') AS period, TO_CHAR(month, 'YYYY-MM') AS month, amount, count, previous,
             amount - previous AS change,
             CASE WHEN previous > 0 THEN ROUND((amount - previous) / previous * 100, 1) END AS "changePercent"
      FROM compared WHERE month >= start_month ORDER BY month
    `, [from, to]),
    query(`
      SELECT category, amount FROM (
        SELECT 'Loan Interest' AS category, COALESCE(SUM(lp.interest_paid), 0) AS amount FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date
        UNION ALL
        SELECT 'Machinery Rental', COALESCE(SUM(mo.rental_fee), 0) FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date
        UNION ALL
        SELECT 'Kadiwa Net Sales', COALESCE(SUM(ks.net_sales), 0) FROM kadiwa_sales ks WHERE ks.sale_date BETWEEN $1::date AND $2::date AND ks.status = 'completed'
      ) totals WHERE amount > 0 ORDER BY amount DESC
    `, [from, to]),
    query(`
      SELECT mo.machinery_name AS name, COUNT(*)::int AS operations, COALESCE(SUM(mo.duration), 0) AS days, COALESCE(SUM(mo.rental_fee), 0) AS revenue
      FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date
      GROUP BY mo.machinery_name ORDER BY revenue DESC, operations DESC
    `, [from, to]),
    // A period inside one calendar month is shown day by day: every day up to
    // today (or the last sale, if later), with ₱0 on days without a sale.
    // Longer periods are shown month by month. gross is the goods sold; sales
    // (the net income) is gross - expenses - costOfGoods.
    from.slice(0, 7) === to.slice(0, 7) ? query(`
      WITH days AS (
        SELECT generate_series($1::date, LEAST($2::date, GREATEST(${SQL_TODAY},
                 (SELECT MAX(sale_date) FROM kadiwa_sales WHERE sale_date BETWEEN $1::date AND $2::date AND status = 'completed'))), INTERVAL '1 day')::date AS day
      )
      SELECT TO_CHAR(d.day, 'Mon FMDD') AS period,
             COALESCE(SUM(ks.groceries + ks.vegetables + ks.meat), 0) AS gross, COALESCE(SUM(ks.cost_of_goods), 0) AS "costOfGoods",
             COALESCE(SUM(ks.net_sales), 0) AS sales, COALESCE(SUM(ks.total_expenses), 0) AS expenses, COUNT(ks.id)::int AS transactions
      FROM days d LEFT JOIN kadiwa_sales ks ON ks.sale_date = d.day AND ks.status = 'completed'
      GROUP BY d.day ORDER BY d.day
    `, [from, to]) : query(`
      SELECT TO_CHAR(DATE_TRUNC('month', ks.sale_date), 'Mon YYYY') AS period,
             COALESCE(SUM(ks.groceries + ks.vegetables + ks.meat), 0) AS gross, COALESCE(SUM(ks.cost_of_goods), 0) AS "costOfGoods",
             COALESCE(SUM(ks.net_sales), 0) AS sales, COALESCE(SUM(ks.total_expenses), 0) AS expenses, COUNT(*)::int AS transactions
      FROM kadiwa_sales ks WHERE ks.sale_date BETWEEN $1::date AND $2::date AND ks.status = 'completed'
      GROUP BY DATE_TRUNC('month', ks.sale_date) ORDER BY DATE_TRUNC('month', ks.sale_date)
    `, [from, to]),
    // One pass per table, joined by member (no per-member sub-queries).
    query(`
      WITH loan_totals AS (
        SELECT l.member_id, COUNT(*)::int AS "totalLoans",
               COUNT(*) FILTER (WHERE l.status = 'paid')::int AS "completedLoans",
               COUNT(*) FILTER (WHERE l.status IN ('active', 'overdue'))::int AS "activeLoans",
               COALESCE(SUM(l.amount), 0) AS "totalBorrowed",
               COALESCE(SUM(l.balance) FILTER (WHERE l.status IN ('active', 'overdue')), 0) AS "outstandingBalance",
               COUNT(*) FILTER (WHERE l.status = 'overdue')::int AS "overdueLoans"
        FROM loans l WHERE l.member_id IS NOT NULL GROUP BY l.member_id
      ), payment_totals AS (
        SELECT l.member_id, COUNT(p.id)::int AS "paymentCount", COALESCE(SUM(p.amount), 0) AS "totalPaid"
        FROM loan_payments p JOIN loans l ON l.id = p.loan_id WHERE l.member_id IS NOT NULL GROUP BY l.member_id
      ), loan_installment_totals AS (
        -- Per loan. An installment a restructuring replaced counts only if it was
        -- already past due then (a late payment); the rest of it was rescheduled.
        SELECT i.loan_id,
               COUNT(*) FILTER (WHERE i.due_date <= ${SQL_TODAY})::int AS due,
               COUNT(*) FILTER (WHERE i.due_date <= ${SQL_TODAY} AND i.amount_paid >= i.amount_due AND i.paid_date <= i.due_date)::int AS on_time,
               COUNT(*) FILTER (WHERE i.due_date <= ${SQL_TODAY} AND NOT (i.amount_paid >= i.amount_due AND i.paid_date <= i.due_date))::int AS late,
               COUNT(*) FILTER (WHERE i.due_date < ${SQL_TODAY} AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL)::int AS overdue
        FROM loan_installments i LEFT JOIN loan_restructurings r ON r.id = i.superseded_by
        WHERE i.superseded_by IS NULL OR i.due_date < r.restructured_on
        GROUP BY i.loan_id
      ), installment_totals AS (
        SELECT l.member_id, SUM(t.due)::int AS "installmentsDue", SUM(t.on_time)::int AS "onTimePayments",
               SUM(t.late)::int AS "latePayments", SUM(t.overdue)::int AS "overdueInstallments"
        FROM loan_installment_totals t JOIN loans l ON l.id = t.loan_id WHERE l.member_id IS NOT NULL GROUP BY l.member_id
      ), restructure_counts AS (
        SELECT loan_id, COUNT(*)::int AS count FROM loan_restructurings GROUP BY loan_id
      ), restructure_totals AS (
        SELECT l.member_id, COUNT(*)::int AS "restructuredLoans", SUM(rc.count)::int AS "restructurings"
        FROM restructure_counts rc JOIN loans l ON l.id = rc.loan_id WHERE l.member_id IS NOT NULL GROUP BY l.member_id
      ), share_totals AS (
        SELECT member_id, COALESCE(SUM(amount), 0) AS total FROM share_contributions GROUP BY member_id
      ), history AS (
        SELECT l.member_id, json_agg(json_build_object(
                 'id', l.id, 'loanNumber', l.loan_number, 'amount', l.amount, 'balance', l.balance, 'status', l.status,
                 'dateApproved', l.date_approved, 'dueDate', l.due_date, 'paymentCount', COALESCE(pc.count, 0), 'totalPaid', COALESCE(pc.total, 0),
                 'onTimePayments', COALESCE(t.on_time, 0), 'latePayments', COALESCE(t.late, 0), 'restructureCount', COALESCE(rc.count, 0)
               ) ORDER BY l.date_approved DESC) AS loans
        FROM loans l
        LEFT JOIN (SELECT loan_id, COUNT(*) AS count, SUM(amount) AS total FROM loan_payments GROUP BY loan_id) pc ON pc.loan_id = l.id
        LEFT JOIN loan_installment_totals t ON t.loan_id = l.id
        LEFT JOIN restructure_counts rc ON rc.loan_id = l.id
        WHERE l.member_id IS NOT NULL GROUP BY l.member_id
      )
      SELECT m.id AS "databaseId", m.member_number AS "memberId",
             TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS "memberName",
             COALESCE(lt."totalLoans", 0) AS "totalLoans", COALESCE(lt."completedLoans", 0) AS "completedLoans",
             COALESCE(lt."activeLoans", 0) AS "activeLoans", COALESCE(lt."totalBorrowed", 0) AS "totalBorrowed",
             COALESCE(pt."totalPaid", 0) AS "totalPaid", COALESCE(lt."outstandingBalance", 0) AS "outstandingBalance",
             COALESCE(lt."overdueLoans", 0) AS "overdueLoans", COALESCE(pt."paymentCount", 0) AS "paymentCount",
             COALESCE(it."installmentsDue", 0) AS "installmentsDue", COALESCE(it."onTimePayments", 0) AS "onTimePayments",
             COALESCE(it."latePayments", 0) AS "latePayments", COALESCE(it."overdueInstallments", 0) AS "overdueInstallments",
             COALESCE(rt."restructuredLoans", 0) AS "restructuredLoans", COALESCE(rt."restructurings", 0) AS "restructurings",
             COALESCE(st.total, 0) AS "shareCapital", COALESCE(h.loans, '[]'::json) AS "loanHistory"
      FROM members m
      LEFT JOIN loan_totals lt ON lt.member_id = m.id
      LEFT JOIN payment_totals pt ON pt.member_id = m.id
      LEFT JOIN installment_totals it ON it.member_id = m.id
      LEFT JOIN restructure_totals rt ON rt.member_id = m.id
      LEFT JOIN share_totals st ON st.member_id = m.id
      LEFT JOIN history h ON h.member_id = m.id
      WHERE m.status <> 'archived'
      ORDER BY COALESCE(st.total, 0) DESC, "memberName"
      LIMIT 1000
    `),
  ]);

  const totals = summary.rows[0];
  const numericKeys = ['totalLoans', 'completedLoans', 'activeLoans', 'totalBorrowed', 'totalPaid', 'outstandingBalance', 'overdueLoans', 'paymentCount', 'installmentsDue', 'onTimePayments', 'latePayments', 'overdueInstallments', 'restructuredLoans', 'restructurings', 'shareCapital'];
  const loanNumbers = ['amount', 'balance', 'totalPaid'];
  const memberRows = memberAnalytics.rows.map((row) => {
    const member = { ...row, databaseId: toNumber(row.databaseId), loanHistory: (row.loanHistory || []).map((loan) => ({ ...loan, ...Object.fromEntries(loanNumbers.map((key) => [key, toNumber(loan[key])])) })) };
    for (const key of numericKeys) member[key] = toNumber(row[key]);
    member.overduePayments = member.overdueInstallments;
    member.onTimePaymentRate = member.installmentsDue > 0 ? Number(((member.onTimePayments / member.installmentsDue) * 100).toFixed(1)) : 0;
    member.repaymentRating = repaymentRating(member);
    Object.assign(member, buildLoanRecommendation(member));
    return member;
  });
  const recommendationCounts = memberRows.reduce((counts, member) => ({ ...counts, [member.assessment]: (counts[member.assessment] || 0) + 1 }), {});
  const loanPayments = toNumber(totals.loanPayments);
  const outstandingBalance = toNumber(totals.outstandingBalance);
  const summaryNumbers = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, toNumber(value)]));
  // Net income for the period, counted as the Dashboard counts it (services/netIncome.js):
  // machinery is rentals + service fees collected + other income - machinery expenses.
  const income = await netIncomeCents({ from, to });

  return res.json({
    period: { from, to },
    summary: {
      ...summaryNumbers,
      netIncome: centsToNumber(income.total),
      machineryNetIncome: centsToNumber(income.parts.machinery),
      totalOperatingRevenue: toNumber(totals.interestCollected) + toNumber(totals.machineryRevenue) + toNumber(totals.kadiwaNetSales),
      paymentToOutstandingRate: loanPayments + outstandingBalance > 0 ? Number(((loanPayments / (loanPayments + outstandingBalance)) * 100).toFixed(1)) : 0,
    },
    // changePercent stays null when the month before had no loans (no percentage of zero).
    loans: mapRows(loans.rows, ['amount', 'count', 'previous', 'change']).map((row) => ({ ...row, changePercent: row.changePercent === null ? null : Number(row.changePercent) })),
    revenue: mapRows(revenue.rows, ['amount']),
    machinery: mapRows(machinery.rows, ['operations', 'days', 'revenue']),
    sales: mapRows(sales.rows, ['gross', 'costOfGoods', 'sales', 'expenses', 'transactions']),
    memberAnalytics: memberRows,
    repaymentRatings: ['Excellent', 'Good', 'Fair', 'Needs Improvement', 'Insufficient data'].map((rating) => ({ rating, members: memberRows.filter((member) => member.repaymentRating === rating).length })),
    loanCapacity: ['Strong', 'Good', 'Moderate', 'Needs Review'].map((assessment) => ({ assessment, members: recommendationCounts[assessment] || 0 })),
    methodology: METHODOLOGY,
  });
}

// GET /api/admin/analytics/revenue?granularity=day|month|year&to=YYYY-MM-DD
// Net income over time, one line per module, as the Dashboard's net income
// counts it: Kadiwa net sales (by sale date), machinery net income (rentals by
// start date, service fees by payment date, other income, less expenses by
// expense date) and loan interest (by payment date). Every day, month or year
// of the window is listed (0 without income), the window ending at `to` (today
// at the latest): the last 30 days, the last 12 months or the last 5 years.
const REVENUE_WINDOWS = { day: { count: 30, label: 'Mon FMDD' }, month: { count: 12, label: 'Mon YYYY' }, year: { count: 5, label: 'YYYY' } };

export async function getRevenueTrend(req, res) {
  const granularity = String(req.query.granularity || 'month');
  const window = REVENUE_WINDOWS[granularity];
  if (!window) throw badRequest('Granularity must be day, month or year.');
  const today = todayDateOnly();
  const asked = req.query.to === undefined ? today : String(req.query.to);
  if (!isValidDateOnly(asked)) throw badRequest('The end date must be a valid YYYY-MM-DD date.');
  const to = asked > today ? today : asked;
  const rows = (await query(
    `WITH bounds AS (
       SELECT $2::date AS last_day,
              (DATE_TRUNC($1, $2::date) - ($3::int - 1) * ('1 ' || $1)::interval)::date AS first_day
     ), buckets AS (
       SELECT generate_series(b.first_day, DATE_TRUNC($1, b.last_day)::date, ('1 ' || $1)::interval)::date AS start FROM bounds b
     ), kadiwa AS (
       SELECT DATE_TRUNC($1, ks.sale_date)::date AS start, SUM(ks.net_sales) AS amount
       FROM kadiwa_sales ks, bounds b WHERE ks.sale_date BETWEEN b.first_day AND b.last_day AND ks.status = 'completed' GROUP BY 1
     ), machinery AS (
       -- As net income counts it (services/netIncome.js): rentals that have started (one also
       -- recorded as a service counts once, as the service), service fees collected, other
       -- income, less machinery expenses. Other income is entered per cropping and year,
       -- without a date: it is placed at the first month of its cropping's report (January
       -- if none), kept inside the window when its year is, as net income counts it by year.
       SELECT start, SUM(amount) AS amount FROM (
         SELECT DATE_TRUNC($1, mo.start_date)::date AS start, mo.rental_fee AS amount
         FROM machinery_operations mo, bounds b
         WHERE mo.start_date BETWEEN b.first_day AND b.last_day
           AND NOT EXISTS (SELECT 1 FROM machinery_services s WHERE s.rental_request_id = mo.rental_request_id)
         UNION ALL
         SELECT DATE_TRUNC($1, p.payment_date)::date, p.amount
         FROM machinery_service_payments p, bounds b WHERE p.payment_date BETWEEN b.first_day AND b.last_day
         UNION ALL
         SELECT DATE_TRUNC($1, LEAST(GREATEST(MAKE_DATE(pb.year, COALESCE(f.from_month, 1), 1), b.first_day), b.last_day))::date, pb.other_income
         FROM machinery_period_balances pb CROSS JOIN bounds b
         LEFT JOIN machinery_report_forms f ON f.cropping_period = pb.cropping_period AND f.year = pb.year
         WHERE pb.other_income <> 0 AND pb.year BETWEEN EXTRACT(YEAR FROM b.first_day) AND EXTRACT(YEAR FROM b.last_day)
         UNION ALL
         SELECT DATE_TRUNC($1, e.expense_date)::date, -e.amount
         FROM machinery_expenses e, bounds b WHERE e.expense_date BETWEEN b.first_day AND b.last_day
       ) parts GROUP BY 1
     ), interest AS (
       SELECT DATE_TRUNC($1, lp.payment_date)::date AS start, SUM(lp.interest_paid) AS amount
       FROM loan_payments lp, bounds b WHERE lp.payment_date BETWEEN b.first_day AND b.last_day GROUP BY 1
     )
     SELECT TO_CHAR(bk.start, 'YYYY-MM-DD') AS start, TO_CHAR(bk.start, $4) AS label,
            COALESCE(k.amount, 0) AS kadiwa, COALESCE(m.amount, 0) AS machinery, COALESCE(i.amount, 0) AS "loanInterest"
     FROM buckets bk
     LEFT JOIN kadiwa k ON k.start = bk.start LEFT JOIN machinery m ON m.start = bk.start LEFT JOIN interest i ON i.start = bk.start
     ORDER BY bk.start`,
    [granularity, to, window.count, window.label]
  )).rows.map((row) => {
    const kadiwa = toNumber(row.kadiwa);
    const machinery = toNumber(row.machinery);
    const loanInterest = toNumber(row.loanInterest);
    return { start: row.start, label: row.label, kadiwa, machinery, loanInterest, total: Math.round((kadiwa + machinery + loanInterest) * 100) / 100 };
  });
  const sum = (key) => Math.round(rows.reduce((total, row) => total + row[key] * 100, 0)) / 100;
  return res.json({
    success: true, granularity, from: rows[0]?.start ?? to, to,
    rows, totals: { kadiwa: sum('kadiwa'), machinery: sum('machinery'), loanInterest: sum('loanInterest'), total: sum('total') },
  });
}

// GET /api/admin/analytics/kadiwa-products?from&to
// Best sellers and items running out (services/kadiwaProducts.js).
export async function getKadiwaProducts(req, res) {
  const { from, to } = readPeriod(req.query);
  return res.json({ success: true, ...(await kadiwaProductAnalytics(from, to)) });
}

// GET /api/admin/analytics/machinery
// The machinery fleet card of Analytics (see services/machineryAnalytics.js).
export async function getMachineryAnalytics(req, res) {
  const { from, to } = readPeriod(req.query);
  refreshRentalStatusesInBackground();
  return res.json({ success: true, ...(await machineryAnalytics(from, to)) });
}

// POST /api/admin/analytics/machinery/recommendations
// Asked only when an admin opens the AI recommendations, as each one is an AI call.
export async function recommendMachinery(req, res) {
  const { from, to } = readPeriod(req.body || {});
  return res.json({ success: true, ...(await machineryRecommendations(from, to)) });
}

// POST /api/admin/analytics/members/:id/credit-advice
// A short suggestion on lending to the member again, from how they repaid
// (see services/creditAdvice.js). The installments are counted as in the
// Member Credit History: one a restructuring replaced counts only if it was
// already past due then, and its days late stop at the restructuring.
export async function adviseMemberCredit(req, res) {
  const memberId = parseId(req.params.id, 'member ID');
  refreshLoanStatusesInBackground();
  const [member, loans, installments, shares] = await Promise.all([
    query(`SELECT id FROM members WHERE id = $1 AND status <> 'archived'`, [memberId]),
    query(
      `SELECT l.id, l.amount, l.balance, l.status, TO_CHAR(l.date_approved, 'YYYY-MM-DD') AS "dateApproved",
              (SELECT COUNT(*) FROM loan_restructurings r WHERE r.loan_id = l.id)::int AS restructurings
         FROM loans l WHERE l.member_id = $1 ORDER BY l.date_approved, l.id`,
      [memberId]
    ),
    query(
      `SELECT i.loan_id AS "loanId", TO_CHAR(i.due_date, 'YYYY-MM-DD') AS "dueDate",
              (i.amount_paid >= i.amount_due AND i.paid_date <= i.due_date) AS "onTime",
              (i.due_date < ${SQL_TODAY} AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL) AS overdue,
              GREATEST(0, CASE
                WHEN i.amount_paid >= i.amount_due THEN COALESCE(i.paid_date, i.last_payment_date, ${SQL_TODAY}) - i.due_date
                WHEN r.id IS NOT NULL THEN r.restructured_on - i.due_date
                ELSE ${SQL_TODAY} - i.due_date END)::int AS "daysLate"
         FROM loan_installments i JOIN loans l ON l.id = i.loan_id
         LEFT JOIN loan_restructurings r ON r.id = i.superseded_by
        WHERE l.member_id = $1 AND i.due_date <= ${SQL_TODAY} AND (i.superseded_by IS NULL OR i.due_date < r.restructured_on)
        ORDER BY i.due_date, i.loan_id, i.installment_number`,
      [memberId]
    ),
    query(`SELECT COALESCE(SUM(amount), 0) AS total FROM share_contributions WHERE member_id = $1`, [memberId]),
  ]);
  if (!member.rows[0]) throw notFound('Member not found.');
  const facts = creditFacts({
    loans: loans.rows.map((loan) => ({ ...loan, amount: toNumber(loan.amount), balance: toNumber(loan.balance) })),
    installments: installments.rows,
    shareCapital: toNumber(shares.rows[0].total),
    today: todayDateOnly(),
  });
  return res.json({ success: true, ...(await adviseOnCredit(facts)), facts: { loans: facts.loans, installments: facts.installments } });
}

// GET /api/admin/dashboard/share-capital/:band
// The members in one share capital band of the dashboard (a bar clicked on
// the chart), most share capital first.
export async function listShareCapitalBandMembers(req, res) {
  const band = SHARE_CAPITAL_BANDS.find((item) => item.key === req.params.band);
  if (!band) throw notFound('Unknown share capital range.');
  const result = await query(`
    WITH totals AS (${MEMBER_SHARE_TOTALS})
    SELECT m.id, m.member_number AS "memberNumber", TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS "memberName",
           m.status, totals.total AS "shareCapital"
    FROM totals JOIN members m ON m.id = totals.id
    WHERE ${inBand(band)}
    ORDER BY totals.total DESC, m.last_name, m.first_name, m.id
  `);
  return res.json({
    success: true,
    band,
    members: result.rows.map((row) => ({ ...row, id: Number(row.id), memberNumber: row.memberNumber || '—', shareCapital: Number(row.shareCapital) })),
  });
}

// Everything the admin dashboard shows, in one request.
export async function getDashboard(req, res) {
  refreshLoanStatusesInBackground();
  refreshRentalStatusesInBackground();
  const [stats, shareCapitalLevels, activities, income] = await Promise.all([
    // The counts after "outstandingLoans" are what needs the admin's attention now.
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM members WHERE status = 'active') AS "totalMembers",
        -- Members (terminated ones left out) with and without a login account.
        (SELECT COUNT(*)::int FROM members m WHERE m.status <> 'archived' AND EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id)) AS "registeredMembers",
        (SELECT COUNT(*)::int FROM members m WHERE m.status <> 'archived' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id)) AS "unregisteredMembers",
        (SELECT COALESCE(SUM(balance), 0) FROM loans WHERE status IN ('active', 'overdue')) AS "outstandingLoans",
        (SELECT COUNT(DISTINCT i.loan_id)::int FROM loan_installments i JOIN loans l ON l.id = i.loan_id
          WHERE l.status <> 'paid' AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL AND i.due_date BETWEEN ${SQL_TODAY} AND ${SQL_TODAY} + 7) AS "loansDueThisWeek",
        (SELECT COUNT(*)::int FROM loans WHERE status = 'overdue') AS "overdueLoans",
        (SELECT COUNT(*)::int FROM loan_requests WHERE status = 'pending') AS "pendingLoanRequests",
        (SELECT COUNT(*)::int FROM rental_requests WHERE status = 'pending') AS "pendingRentalRequests",
        (SELECT COUNT(*)::int FROM machinery_operations WHERE status = 'scheduled') AS "scheduledOperations",
        (SELECT COUNT(*)::int FROM kadiwa_inventory WHERE stock <= reorder_level AND deleted_at IS NULL) AS "lowStockItems"
    `),
    // Members by their share capital now, in bands up to the PHP 20,000 maximum.
    query(`
      WITH totals AS (${MEMBER_SHARE_TOTALS})
      SELECT ${SHARE_CAPITAL_BANDS.map((band) => `COUNT(*) FILTER (WHERE ${inBand(band)})::int AS "${band.key}"`).join(',\n             ')}
      FROM totals
    `),
    query(`
      SELECT * FROM (
        (SELECT 'member-' || id AS id, 'Member' AS type, 'New member registration: ' || TRIM(CONCAT_WS(' ', first_name, last_name)) AS action, created_at AS at FROM members ORDER BY created_at DESC LIMIT 5)
        UNION ALL
        (SELECT 'payment-' || p.id, 'Loan', 'Loan payment received from ' || l.member_name || ': PHP ' || to_char(p.amount, 'FM999,999,990.00'), p.created_at FROM loan_payments p JOIN loans l ON l.id = p.loan_id ORDER BY p.created_at DESC LIMIT 5)
        UNION ALL
        (SELECT 'loan-' || id, 'Loan', 'Loan approved for ' || member_name || ': PHP ' || to_char(amount, 'FM999,999,990.00'), created_at FROM loans ORDER BY created_at DESC LIMIT 5)
        UNION ALL
        (SELECT 'machinery-' || id, 'Machinery', 'Machinery rental: ' || member_name || ' - ' || machinery_name, created_at FROM machinery_operations ORDER BY created_at DESC LIMIT 5)
        UNION ALL
        (SELECT 'sale-' || id, 'Store', 'Kadiwa sale recorded by ' || encoder_name || ': PHP ' || to_char(net_sales, 'FM999,999,990.00'), created_at FROM kadiwa_sales WHERE status = 'completed' ORDER BY created_at DESC LIMIT 5)
      ) recent ORDER BY at DESC LIMIT 5
    `),
    // All time; see services/netIncome.js for what is counted.
    netIncomeCents(),
  ]);
  const row = stats.rows[0];
  return res.json({
    success: true,
    stats: {
      ...row,
      outstandingLoans: toNumber(row.outstandingLoans),
      netIncome: centsToNumber(income.total),
      netIncomeBreakdown: Object.fromEntries(Object.entries(income.parts).map(([key, cents]) => [key, centsToNumber(cents)])),
      // The statutory funds set aside from that net income (none when there is no net income).
      statutoryFunds: computeDividend({ netIncomeCents: income.total, memberShareCents: 0, totalShareCents: 0 }).funds
        .map(({ key, label, percent, amount }) => ({ key, label, percent, amount: centsToNumber(amount) })),
    },
    shareCapitalLevels: SHARE_CAPITAL_BANDS.map((band) => ({ ...band, members: shareCapitalLevels.rows[0][band.key] })),
    recentActivities: activities.rows,
  });
}
