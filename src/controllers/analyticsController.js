import { query } from '../config/db.js';

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? value
    : null;
}

function toNumber(value) {
  return Number(value || 0);
}

function mapRows(rows, numberFields = []) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    numberFields.includes(key) ? toNumber(value) : value,
  ])));
}

function repaymentRating(member) {
  if (member.totalLoans === 0 || member.paymentCount === 0) return 'Insufficient data';
  if (member.overduePayments === 0 && member.onTimePaymentRate >= 90 && member.completedLoans >= 1) return 'Excellent';
  if (member.overduePayments === 0 && member.onTimePaymentRate >= 75) return 'Good';
  if (member.onTimePaymentRate >= 50) return 'Fair';
  return 'Needs Improvement';
}

function buildLoanRecommendation(member) {
  if (member.totalLoans === 0 || member.paymentCount === 0) {
    return {
      assessment: 'Needs Review',
      recommendation: 'Insufficient financial history to generate a reliable AI recommendation.',
      reasons: [],
    };
  }

  const reasons = [];
  if (member.onTimePaymentRate >= 90) reasons.push('Strong repayment history');
  if (member.onTimePaymentRate >= 80) reasons.push('High on-time payment rate');
  if (member.completedLoans > 0) reasons.push('Previous loans successfully completed');
  if (member.outstandingBalance <= member.totalBorrowed * 0.25) reasons.push('Low outstanding balance');
  if (member.paymentCount >= member.totalLoans * 2) reasons.push('Consistent payment activity');
  if (member.shareCapital > 0) reasons.push('Strong share contribution');

  const suitable = member.completedLoans > 0 && member.onTimePaymentRate >= 80 && member.overduePayments === 0;
  const assessment = suitable ? (member.onTimePaymentRate >= 90 ? 'Strong' : 'Good') : member.onTimePaymentRate >= 50 ? 'Moderate' : 'Needs Review';
  return {
    assessment,
    recommendation: suitable
      ? 'This member shows strong historical repayment performance and may be considered for a higher loan amount, subject to cooperative review.'
      : 'Review this member\'s repayment history and current obligations before considering a higher loan amount.',
    reasons,
  };
}

export async function getAnalytics(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = `${new Date().getFullYear()}-01-01`;
  const from = req.query.from === undefined ? defaultFrom : parseDate(req.query.from);
  const to = req.query.to === undefined ? today : parseDate(req.query.to);

  if (!from || !to) return res.status(400).json({ message: 'Analytics dates must be valid YYYY-MM-DD values.' });
  if (from > to) return res.status(400).json({ message: 'The analytics start date must be before the end date.' });

  try {
    const [summary, membership, loans, revenue, machinery, sales, memberAnalytics] = await Promise.all([
      query(`
        SELECT
          (SELECT COUNT(*)::int FROM members WHERE status = 'active') AS "activeMembers",
          (SELECT COUNT(*)::int FROM members WHERE membership_date BETWEEN $1::date AND $2::date AND status <> 'archived') AS "newMembers",
          (SELECT COALESCE(SUM(sc.amount), 0)::numeric FROM share_contributions sc WHERE sc.contribution_date BETWEEN $1::date AND $2::date) AS "shareCapital",
          (SELECT COALESCE(SUM(lp.amount), 0)::numeric FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date) AS "loanPayments",
          (SELECT COALESCE(SUM(lp.interest_paid), 0)::numeric FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date) AS "interestCollected",
          (SELECT COALESCE(SUM(mo.rental_fee), 0)::numeric FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date) AS "machineryRevenue",
          (SELECT COALESCE(SUM(ks.net_sales), 0)::numeric FROM kadiwa_sales ks WHERE ks.created_at::date BETWEEN $1::date AND $2::date AND ks.status = 'completed') AS "kadiwaNetSales",
          (SELECT COALESCE(SUM(l.balance), 0)::numeric FROM loans l WHERE l.status IN ('active', 'overdue')) AS "outstandingBalance",
          (SELECT COUNT(*)::int FROM loans WHERE status = 'overdue') AS "overdueLoans",
          (SELECT COUNT(*)::int FROM loan_requests lr WHERE lr.submitted_at::date BETWEEN $1::date AND $2::date) AS "loanApplications",
          (SELECT COUNT(*)::int FROM loan_requests lr WHERE lr.status = 'pending') AS "pendingLoanApplications",
          (SELECT COALESCE(SUM(lr.amount), 0)::numeric FROM loan_requests lr WHERE lr.submitted_at::date BETWEEN $1::date AND $2::date) AS "requestedLoanAmount",
          (SELECT COALESCE(SUM(lr.maximum_eligible_amount), 0)::numeric FROM loan_requests lr WHERE lr.submitted_at::date BETWEEN $1::date AND $2::date) AS "maximumEligibleAmount",
          (SELECT COALESCE(SUM(lr.total_repayment), 0)::numeric FROM loan_requests lr WHERE lr.submitted_at::date BETWEEN $1::date AND $2::date) AS "projectedRepayment"
      `, [from, to]),
      query(`
        SELECT TO_CHAR(DATE_TRUNC('month', membership_date), 'Mon YYYY') AS period,
               COUNT(*)::int AS members
        FROM members
        WHERE membership_date BETWEEN $1::date AND $2::date AND status <> 'archived'
        GROUP BY DATE_TRUNC('month', membership_date)
        ORDER BY DATE_TRUNC('month', membership_date)
      `, [from, to]),
      query(`
        SELECT TO_CHAR(DATE_TRUNC('month', l.date_approved), 'Mon YYYY') AS period,
               COALESCE(SUM(l.amount), 0)::numeric AS amount,
               COUNT(*)::int AS count
        FROM loans l
        WHERE l.date_approved BETWEEN $1::date AND $2::date
        GROUP BY DATE_TRUNC('month', l.date_approved)
        ORDER BY DATE_TRUNC('month', l.date_approved)
      `, [from, to]),
      query(`
        SELECT category, amount::numeric AS amount
        FROM (
          SELECT 'Loan Interest' AS category, COALESCE(SUM(lp.interest_paid), 0)::numeric AS amount
          FROM loan_payments lp WHERE lp.payment_date BETWEEN $1::date AND $2::date
          UNION ALL
          SELECT 'Machinery Rental', COALESCE(SUM(mo.rental_fee), 0)::numeric
          FROM machinery_operations mo WHERE mo.start_date BETWEEN $1::date AND $2::date
          UNION ALL
          SELECT 'Kadiwa Net Sales', COALESCE(SUM(ks.net_sales), 0)::numeric
          FROM kadiwa_sales ks WHERE ks.created_at::date BETWEEN $1::date AND $2::date AND ks.status = 'completed'
        ) totals
        WHERE amount > 0
        ORDER BY amount DESC
      `, [from, to]),
      query(`
        SELECT mo.machinery_name AS name,
               COUNT(*)::int AS operations,
               COALESCE(SUM(mo.duration), 0)::numeric AS days,
               COALESCE(SUM(mo.rental_fee), 0)::numeric AS revenue
        FROM machinery_operations mo
        WHERE mo.start_date BETWEEN $1::date AND $2::date
        GROUP BY mo.machinery_name
        ORDER BY revenue DESC, operations DESC
      `, [from, to]),
      query(`
        SELECT TO_CHAR(DATE_TRUNC('month', ks.created_at), 'Mon YYYY') AS period,
               COALESCE(SUM(ks.net_sales), 0)::numeric AS sales,
               COALESCE(SUM(ks.total_expenses), 0)::numeric AS expenses,
               COUNT(*)::int AS transactions
        FROM kadiwa_sales ks
        WHERE ks.created_at::date BETWEEN $1::date AND $2::date AND ks.status = 'completed'
        GROUP BY DATE_TRUNC('month', ks.created_at)
        ORDER BY DATE_TRUNC('month', ks.created_at)
      `, [from, to]),
      query(`
        WITH loan_totals AS (
          SELECT l.member_id,
                 COUNT(*)::int AS "totalLoans",
                 COUNT(*) FILTER (WHERE l.status = 'paid')::int AS "completedLoans",
                 COUNT(*) FILTER (WHERE l.status = 'active')::int AS "activeLoans",
                 COALESCE(SUM(l.amount), 0)::numeric AS "totalBorrowed",
                 COALESCE(SUM(l.balance) FILTER (WHERE l.status IN ('active', 'overdue')), 0)::numeric AS "outstandingBalance",
                 COUNT(*) FILTER (WHERE l.status = 'overdue')::int AS "overdueLoans"
          FROM loans l
          WHERE l.member_id IS NOT NULL
          GROUP BY l.member_id
        ), payment_totals AS (
          SELECT l.member_id,
                 COUNT(p.id)::int AS "paymentCount",
                 COALESCE(SUM(p.amount), 0)::numeric AS "totalPaid",
                 COUNT(p.id) FILTER (WHERE p.payment_date <= l.due_date)::int AS "onTimePayments",
                 COUNT(p.id) FILTER (WHERE p.payment_date > l.due_date)::int AS "latePayments"
          FROM loans l
          LEFT JOIN loan_payments p ON p.loan_id = l.id
          WHERE l.member_id IS NOT NULL
          GROUP BY l.member_id
        ), share_totals AS (
          SELECT m.id AS member_id,
                 GREATEST(COALESCE(SUM(sc.amount), 0), COALESCE(m.share_capital, 0))::numeric AS "shareCapital"
          FROM members m
          LEFT JOIN share_contributions sc ON sc.member_id = m.id
          GROUP BY m.id, m.share_capital
        )
        SELECT m.id AS "databaseId",
               m.member_number AS "memberId",
               TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS "memberName",
               COALESCE(lt."totalLoans", 0)::int AS "totalLoans",
               COALESCE(lt."completedLoans", 0)::int AS "completedLoans",
               COALESCE(lt."activeLoans", 0)::int AS "activeLoans",
               COALESCE(lt."totalBorrowed", 0)::numeric AS "totalBorrowed",
               COALESCE(pt."totalPaid", 0)::numeric AS "totalPaid",
               COALESCE(lt."outstandingBalance", 0)::numeric AS "outstandingBalance",
               COALESCE(lt."overdueLoans", 0)::int AS "overdueLoans",
               COALESCE(pt."paymentCount", 0)::int AS "paymentCount",
               COALESCE(pt."onTimePayments", 0)::int AS "onTimePayments",
               COALESCE(pt."latePayments", 0)::int AS "latePayments",
               COALESCE(st."shareCapital", 0)::numeric AS "shareCapital",
               COALESCE((SELECT SUM(sc2.amount) FROM share_contributions sc2 WHERE sc2.member_id = m.id), 0)::numeric AS "savings",
               COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', l.id, 'loanNumber', l.loan_number, 'amount', l.amount, 'balance', l.balance,
                   'status', l.status, 'dateApproved', l.date_approved, 'dueDate', l.due_date,
                   'paymentCount', (SELECT COUNT(*) FROM loan_payments p2 WHERE p2.loan_id = l.id),
                   'totalPaid', (SELECT COALESCE(SUM(p3.amount), 0) FROM loan_payments p3 WHERE p3.loan_id = l.id)
                 ) ORDER BY l.date_approved DESC)
                 FROM loans l WHERE l.member_id = m.id
               ), '[]'::json) AS "loanHistory"
        FROM members m
        LEFT JOIN loan_totals lt ON lt.member_id = m.id
        LEFT JOIN payment_totals pt ON pt.member_id = m.id
        LEFT JOIN share_totals st ON st.member_id = m.id
        WHERE m.status <> 'archived'
        ORDER BY "shareCapital" DESC, "memberName"
      `),
    ]);

    const totals = summary.rows[0];
    const loanPayments = toNumber(totals.loanPayments);
    const outstandingBalance = toNumber(totals.outstandingBalance);

    const memberRows = memberAnalytics.rows.map((row) => {
      const member = {
        ...row,
        databaseId: toNumber(row.databaseId),
        totalLoans: toNumber(row.totalLoans),
        completedLoans: toNumber(row.completedLoans),
        activeLoans: toNumber(row.activeLoans),
        totalBorrowed: toNumber(row.totalBorrowed),
        totalPaid: toNumber(row.totalPaid),
        outstandingBalance: toNumber(row.outstandingBalance),
        overdueLoans: toNumber(row.overdueLoans),
        paymentCount: toNumber(row.paymentCount),
        onTimePayments: toNumber(row.onTimePayments),
        latePayments: toNumber(row.latePayments),
        shareCapital: toNumber(row.shareCapital),
        savings: toNumber(row.savings),
        loanHistory: row.loanHistory || [],
      };
      member.overduePayments = member.overdueLoans;
      member.onTimePaymentRate = member.paymentCount > 0 ? Number(((member.onTimePayments / member.paymentCount) * 100).toFixed(1)) : 0;
      member.repaymentRating = repaymentRating(member);
      Object.assign(member, buildLoanRecommendation(member));
      return member;
    });
    const recommendationCounts = memberRows.reduce((counts, member) => {
      counts[member.assessment] = (counts[member.assessment] || 0) + 1;
      return counts;
    }, {});

    return res.json({
      period: { from, to },
      summary: {
        activeMembers: toNumber(totals.activeMembers),
        newMembers: toNumber(totals.newMembers),
        shareCapital: toNumber(totals.shareCapital),
        loanPayments,
        interestCollected: toNumber(totals.interestCollected),
        machineryRevenue: toNumber(totals.machineryRevenue),
        kadiwaNetSales: toNumber(totals.kadiwaNetSales),
        totalOperatingRevenue: toNumber(totals.interestCollected) + toNumber(totals.machineryRevenue) + toNumber(totals.kadiwaNetSales),
        outstandingBalance,
        overdueLoans: toNumber(totals.overdueLoans),
        loanApplications: toNumber(totals.loanApplications),
        pendingLoanApplications: toNumber(totals.pendingLoanApplications),
        requestedLoanAmount: toNumber(totals.requestedLoanAmount),
        maximumEligibleAmount: toNumber(totals.maximumEligibleAmount),
        projectedRepayment: toNumber(totals.projectedRepayment),
        paymentToOutstandingRate: loanPayments + outstandingBalance > 0 ? Number(((loanPayments / (loanPayments + outstandingBalance)) * 100).toFixed(1)) : 0,
      },
      membership: mapRows(membership.rows, ['members']),
      loans: mapRows(loans.rows, ['amount', 'count']),
      revenue: mapRows(revenue.rows, ['amount']),
      machinery: mapRows(machinery.rows, ['operations', 'days', 'revenue']),
      sales: mapRows(sales.rows, ['sales', 'expenses', 'transactions']),
      memberAnalytics: memberRows,
      repaymentRatings: ['Excellent', 'Good', 'Fair', 'Needs Improvement'].map((rating) => ({
        rating,
        members: memberRows.filter((member) => member.repaymentRating === rating).length,
      })),
      loanCapacity: ['Strong', 'Good', 'Moderate', 'Needs Review'].map((assessment) => ({
        assessment,
        members: recommendationCounts[assessment] || 0,
      })),
    });
  } catch (error) {
    console.error('Analytics error:', error);
    return res.status(500).json({ message: 'Unable to load analytics.' });
  }
}
