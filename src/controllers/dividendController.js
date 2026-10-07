import { query } from '../config/db.js';
import { todayDateOnly } from '../utils/dates.js';
import { badRequest, notFound } from '../utils/http.js';
import { toCents } from '../utils/money.js';
import { centsToNumber, netIncomeCents } from '../services/netIncome.js';
import { computeDividend, DIVIDEND_POOL_PERCENT, PATRONAGE_POOL_PERCENT, STATUTORY_PERCENT } from '../services/dividends.js';

// GET /api/members/me/dividend?year=YYYY
// The signed-in member's dividend for a calendar year (default: this year, to
// date), from the year's net income and the paid-up share capital at the end
// of the year. An estimate from the records: the General Assembly declares the
// actual dividend.
export async function getMyDividend(req, res) {
  const memberId = Number(req.user?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw notFound('No member record is linked to this account.');
  const today = todayDateOnly();
  const thisYear = Number(today.slice(0, 4));
  const year = req.query.year === undefined || req.query.year === '' ? thisYear : Number(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > thisYear) throw badRequest(`Choose a year from 2000 to ${thisYear}.`);

  const from = `${year}-01-01`;
  const yearComplete = year < thisYear;
  const asOf = yearComplete ? `${year}-12-31` : today;

  const [member, shares, income] = await Promise.all([
    query(`SELECT EXTRACT(YEAR FROM membership_date)::int AS "joinedYear" FROM members WHERE id = $1 AND status <> 'archived'`, [memberId]),
    query(
      `SELECT COALESCE(SUM(sc.amount) FILTER (WHERE sc.member_id = $1), 0) AS member,
              COALESCE(SUM(sc.amount), 0) AS total
       FROM share_contributions sc JOIN members m ON m.id = sc.member_id
       WHERE m.status <> 'archived' AND sc.contribution_date <= $2::date`,
      [memberId, asOf]
    ),
    netIncomeCents({ from, to: asOf }),
  ]);
  if (!member.rows[0]) throw notFound('Linked member record not found.');

  const result = computeDividend({ netIncomeCents: income.total, memberShareCents: toCents(shares.rows[0].member), totalShareCents: toCents(shares.rows[0].total) });
  const peso = centsToNumber;
  return res.json({
    success: true,
    data: {
      year, from, asOf, yearComplete,
      firstYear: Math.min(member.rows[0].joinedYear || thisYear, thisYear),
      rates: { statutory: STATUTORY_PERCENT, dividendPool: DIVIDEND_POOL_PERCENT, patronageRefundPool: PATRONAGE_POOL_PERCENT },
      netIncome: peso(result.netIncome),
      netIncomeParts: Object.fromEntries(Object.entries(income.parts).map(([key, cents]) => [key, peso(cents)])),
      statutoryFunds: result.funds.map(({ key, label, percent, amount }) => ({ key, label, percent, amount: peso(amount) })),
      statutoryTotal: peso(result.statutoryTotal),
      netSurplus: peso(result.netSurplus),
      dividendPool: peso(result.dividendPool),
      patronageRefundPool: peso(result.patronageRefundPool),
      memberShareCapital: peso(result.memberShare),
      totalShareCapital: peso(result.totalShare),
      shareRatio: result.shareRatio,
      dividend: peso(result.dividend),
    },
  });
}
