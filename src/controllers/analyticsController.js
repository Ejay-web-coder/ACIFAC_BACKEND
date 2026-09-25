import { query } from '../config/db.js';
import { SQL_TODAY, TIME_ZONE } from '../config/env.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest } from '../utils/http.js';
import { refreshLoanStatusesInBackground } from '../services/loanService.js';
import { refreshRentalStatusesInBackground } from './machineryController.js';

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

export async function getAnalytics(req, res) {
  const today = todayDateOnly();
  const from = req.query.from === undefined ? `${today.slice(0, 4)}-01-01` : String(req.query.from);
  const to = req.query.to === undefined ? today : String(req.query.to);
  if (!isValidDateOnly(from) || !isValidDateOnly(to)) throw badRequest('Analytics dates must be valid YYYY-MM-DD values.');
  if (from > to) throw badRequest('The analytics start date must be before the end date.');

  refreshLoanStatusesInBackground();
  refreshRentalStatusesInBackground();
  const localDate = (column) => `(${column} AT TIME ZONE '${TIME_ZONE}')::date`;

  const [summary, membership, loans, revenue, machinery, sales, memberAnalytics] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM members WHERE status = 'active') AS "activeMembers",
        (SELECT COUNT(*)::int FROM members) AS "totalMembers",
        (SELECT COUNT(*)::int FROM members WHERE status = 'archived') AS "archivedMembers",
        (SELECT COUNT(*)::int FROM members WHERE membership_date BETWEEN $1::date AND $2::date AND status <> 'archived') AS "newMembers",
        (SELECT COALESCE(SUM(sc.amount), 0) FROM share_contributions sc WHERE sc.contribution_date BETWEEN $1::date AND $2::date) AS "shareCapital",
        (SELECT COALESCE(SUM(sc.amount), 0) FROM share_contributions sc) AS "totalShareCapital",
        (SELECT COALESCE(SUM(st.amount), 0) FROM savings_transactions st) AS "totalSavings",
        (SELECT COALESCE(SUM(st.amount), 0) FROM savings_transactions st WHERE st.transaction_date BETWEEN $1::date AND $2::date) AS "savingsDeposits",
        (SELECT COALESCE(SUM(lp.amount), 0) FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date) AS "loanPayments",
        (SELECT COALESCE(SUM(lp.amount), 0) FROM loan_payments lp) AS "totalLoanPayments",
        (SELECT COALESCE(SUM(lp.interest_paid), 0) FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date) AS "interestCollected",
        (SELECT COALESCE(SUM(mo.rental_fee), 0) FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date) AS "machineryRevenue",
        (SELECT COALESCE(SUM(ks.net_sales), 0) FROM kadiwa_sales ks WHERE ${localDate('ks.created_at')} BETWEEN $1::date AND $2::date AND ks.status = 'completed') AS "kadiwaNetSales",
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
    query(`
      SELECT TO_CHAR(DATE_TRUNC('month', membership_date), 'Mon YYYY') AS period, COUNT(*)::int AS members
      FROM members WHERE membership_date BETWEEN $1::date AND $2::date AND status <> 'archived'
      GROUP BY DATE_TRUNC('month', membership_date) ORDER BY DATE_TRUNC('month', membership_date)
    `, [from, to]),
    query(`
      SELECT TO_CHAR(DATE_TRUNC('month', l.date_approved), 'Mon YYYY') AS period, COALESCE(SUM(l.amount), 0) AS amount, COUNT(*)::int AS count
      FROM loans l WHERE l.date_approved BETWEEN $1::date AND $2::date
      GROUP BY DATE_TRUNC('month', l.date_approved) ORDER BY DATE_TRUNC('month', l.date_approved)
    `, [from, to]),
    query(`
      SELECT category, amount FROM (
        SELECT 'Loan Interest' AS category, COALESCE(SUM(lp.interest_paid), 0) AS amount FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date
        UNION ALL
        SELECT 'Machinery Rental', COALESCE(SUM(mo.rental_fee), 0) FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date
        UNION ALL
        SELECT 'Kadiwa Net Sales', COALESCE(SUM(ks.net_sales), 0) FROM kadiwa_sales ks WHERE ${localDate('ks.created_at')} BETWEEN $1::date AND $2::date AND ks.status = 'completed'
      ) totals WHERE amount > 0 ORDER BY amount DESC
    `, [from, to]),
    query(`
      SELECT mo.machinery_name AS name, COUNT(*)::int AS operations, COALESCE(SUM(mo.duration), 0) AS days, COALESCE(SUM(mo.rental_fee), 0) AS revenue
      FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date
      GROUP BY mo.machinery_name ORDER BY revenue DESC, operations DESC
    `, [from, to]),
    query(`
      SELECT TO_CHAR(DATE_TRUNC('month', ${localDate('ks.created_at')}), 'Mon YYYY') AS period,
             COALESCE(SUM(ks.net_sales), 0) AS sales, COALESCE(SUM(ks.total_expenses), 0) AS expenses, COUNT(*)::int AS transactions
      FROM kadiwa_sales ks WHERE ${localDate('ks.created_at')} BETWEEN $1::date AND $2::date AND ks.status = 'completed'
      GROUP BY DATE_TRUNC('month', ${localDate('ks.created_at')}) ORDER BY DATE_TRUNC('month', ${localDate('ks.created_at')})
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
      ), installment_totals AS (
        SELECT l.member_id,
               COUNT(*) FILTER (WHERE i.due_date <= ${SQL_TODAY})::int AS "installmentsDue",
               COUNT(*) FILTER (WHERE i.due_date <= ${SQL_TODAY} AND i.amount_paid >= i.amount_due AND i.paid_date <= i.due_date)::int AS "onTimePayments",
               COUNT(*) FILTER (WHERE i.due_date <= ${SQL_TODAY} AND NOT (i.amount_paid >= i.amount_due AND i.paid_date <= i.due_date))::int AS "latePayments",
               COUNT(*) FILTER (WHERE i.due_date < ${SQL_TODAY} AND i.amount_paid < i.amount_due)::int AS "overdueInstallments"
        FROM loan_installments i JOIN loans l ON l.id = i.loan_id WHERE l.member_id IS NOT NULL GROUP BY l.member_id
      ), share_totals AS (
        SELECT member_id, COALESCE(SUM(amount), 0) AS total FROM share_contributions GROUP BY member_id
      ), savings_totals AS (
        SELECT member_id, COALESCE(SUM(amount), 0) AS total FROM savings_transactions GROUP BY member_id
      ), history AS (
        SELECT l.member_id, json_agg(json_build_object(
                 'id', l.id, 'loanNumber', l.loan_number, 'amount', l.amount, 'balance', l.balance, 'status', l.status,
                 'dateApproved', l.date_approved, 'dueDate', l.due_date, 'paymentCount', COALESCE(pc.count, 0), 'totalPaid', COALESCE(pc.total, 0)
               ) ORDER BY l.date_approved DESC) AS loans
        FROM loans l
        LEFT JOIN (SELECT loan_id, COUNT(*) AS count, SUM(amount) AS total FROM loan_payments GROUP BY loan_id) pc ON pc.loan_id = l.id
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
             COALESCE(st.total, 0) AS "shareCapital", COALESCE(sv.total, 0) AS "savings", COALESCE(h.loans, '[]'::json) AS "loanHistory"
      FROM members m
      LEFT JOIN loan_totals lt ON lt.member_id = m.id
      LEFT JOIN payment_totals pt ON pt.member_id = m.id
      LEFT JOIN installment_totals it ON it.member_id = m.id
      LEFT JOIN share_totals st ON st.member_id = m.id
      LEFT JOIN savings_totals sv ON sv.member_id = m.id
      LEFT JOIN history h ON h.member_id = m.id
      WHERE m.status <> 'archived'
      ORDER BY COALESCE(st.total, 0) DESC, "memberName"
      LIMIT 1000
    `),
  ]);

  const totals = summary.rows[0];
  const numericKeys = ['totalLoans', 'completedLoans', 'activeLoans', 'totalBorrowed', 'totalPaid', 'outstandingBalance', 'overdueLoans', 'paymentCount', 'installmentsDue', 'onTimePayments', 'latePayments', 'overdueInstallments', 'shareCapital', 'savings'];
  const memberRows = memberAnalytics.rows.map((row) => {
    const member = { ...row, databaseId: toNumber(row.databaseId), loanHistory: row.loanHistory || [] };
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

  return res.json({
    period: { from, to },
    summary: {
      ...summaryNumbers,
      totalOperatingRevenue: toNumber(totals.interestCollected) + toNumber(totals.machineryRevenue) + toNumber(totals.kadiwaNetSales),
      paymentToOutstandingRate: loanPayments + outstandingBalance > 0 ? Number(((loanPayments / (loanPayments + outstandingBalance)) * 100).toFixed(1)) : 0,
    },
    membership: mapRows(membership.rows, ['members']),
    loans: mapRows(loans.rows, ['amount', 'count']),
    revenue: mapRows(revenue.rows, ['amount']),
    machinery: mapRows(machinery.rows, ['operations', 'days', 'revenue']),
    sales: mapRows(sales.rows, ['sales', 'expenses', 'transactions']),
    memberAnalytics: memberRows,
    repaymentRatings: ['Excellent', 'Good', 'Fair', 'Needs Improvement', 'Insufficient data'].map((rating) => ({ rating, members: memberRows.filter((member) => member.repaymentRating === rating).length })),
    loanCapacity: ['Strong', 'Good', 'Moderate', 'Needs Review'].map((assessment) => ({ assessment, members: recommendationCounts[assessment] || 0 })),
    methodology: METHODOLOGY,
  });
}

// Everything the admin dashboard shows, in one request.
export async function getDashboard(req, res) {
  refreshLoanStatusesInBackground();
  refreshRentalStatusesInBackground();
  const [stats, activities] = await Promise.all([
    query(`
      SELECT
        (SELECT COUNT(*)::int FROM members WHERE status = 'active') AS "totalMembers",
        (SELECT COALESCE(SUM(balance), 0) FROM loans WHERE status IN ('active', 'overdue')) AS "outstandingLoans",
        (SELECT COUNT(*)::int FROM machinery_operations) AS "machineryOperations",
        (SELECT COALESCE(SUM(net_sales), 0) FROM kadiwa_sales WHERE status = 'completed') AS "kadiwaRevenue",
        (SELECT COUNT(DISTINCT i.loan_id)::int FROM loan_installments i JOIN loans l ON l.id = i.loan_id
          WHERE l.status <> 'paid' AND i.amount_paid < i.amount_due AND i.due_date BETWEEN ${SQL_TODAY} AND ${SQL_TODAY} + 7) AS "loansDueThisWeek",
        (SELECT COUNT(*)::int FROM loans WHERE status = 'overdue') AS "overdueLoans",
        (SELECT COUNT(*)::int FROM loan_requests WHERE status = 'pending') AS "pendingLoanRequests",
        (SELECT COUNT(*)::int FROM rental_requests WHERE status = 'pending') AS "pendingRentalRequests",
        (SELECT COUNT(*)::int FROM machinery_operations WHERE status = 'scheduled') AS "scheduledOperations",
        (SELECT COUNT(*)::int FROM kadiwa_inventory WHERE stock <= reorder_level) AS "lowStockItems"
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
  ]);
  const row = stats.rows[0];
  const alerts = [
    row.overdueLoans > 0 && { id: 'loans-overdue', message: `${row.overdueLoans} loan${row.overdueLoans === 1 ? ' is' : 's are'} overdue`, type: 'warning' },
    row.loansDueThisWeek > 0 && { id: 'loans-due', message: `${row.loansDueThisWeek} loan${row.loansDueThisWeek === 1 ? '' : 's'} due for payment this week`, type: 'warning' },
    row.pendingLoanRequests > 0 && { id: 'loan-requests', message: `${row.pendingLoanRequests} loan application${row.pendingLoanRequests === 1 ? '' : 's'} waiting for review`, type: 'info' },
    row.pendingRentalRequests > 0 && { id: 'rental-requests', message: `${row.pendingRentalRequests} rental request${row.pendingRentalRequests === 1 ? '' : 's'} waiting for review`, type: 'info' },
    row.scheduledOperations > 0 && { id: 'machinery-scheduled', message: `${row.scheduledOperations} machinery operation${row.scheduledOperations === 1 ? '' : 's'} scheduled`, type: 'info' },
    row.lowStockItems > 0 && { id: 'kadiwa-low-stock', message: `${row.lowStockItems} Kadiwa item${row.lowStockItems === 1 ? '' : 's'} at or below reorder level`, type: 'warning' },
  ].filter(Boolean);
  return res.json({
    success: true,
    stats: { ...row, outstandingLoans: toNumber(row.outstandingLoans), kadiwaRevenue: toNumber(row.kadiwaRevenue) },
    alerts,
    recentActivities: activities.rows,
  });
}
