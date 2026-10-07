// Distribution of a year's net income, as the cooperative computes it:
//   Statutory funds    30% of net income (Reserve 10%, Education & Training 10%,
//                      Community Development 3%, Optional 7%)
//   Net surplus        net income - statutory funds (70%)
//   Dividend pool      50% of net surplus (interest on share capital)
//   Patronage refund   50% of net surplus
//   Member's dividend  dividend pool x (member's share capital / total paid-up share capital)
// All amounts are integer centavos; each fund and pool is rounded to the
// centavo and the last part takes the remainder, so the parts always add up.
export const STATUTORY_FUNDS = [
  { key: 'reserve', label: 'Reserve Fund', percent: 10 },
  { key: 'education', label: 'Education & Training Fund', percent: 10 },
  { key: 'community', label: 'Community Development Fund', percent: 3 },
  { key: 'optional', label: 'Optional Fund', percent: 7 },
];
export const STATUTORY_PERCENT = STATUTORY_FUNDS.reduce((sum, fund) => sum + fund.percent, 0);
export const DIVIDEND_POOL_PERCENT = 50;
export const PATRONAGE_POOL_PERCENT = 100 - DIVIDEND_POOL_PERCENT;

// a x b / c rounded half up, without floating point (c > 0, a and b >= 0).
function mulDiv(a, b, c) {
  const numerator = BigInt(a) * BigInt(b);
  const denominator = BigInt(c);
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/**
 * The member's dividend from a year's net income.
 * netIncomeCents may be zero or negative: there is then no surplus to share.
 */
export function computeDividend({ netIncomeCents, memberShareCents, totalShareCents }) {
  const distributable = Math.max(0, netIncomeCents);
  const funds = STATUTORY_FUNDS.map((fund) => ({ ...fund, amount: mulDiv(distributable, fund.percent, 100) }));
  const statutoryTotal = funds.reduce((sum, fund) => sum + fund.amount, 0);
  const netSurplus = distributable - statutoryTotal;
  const dividendPool = mulDiv(netSurplus, DIVIDEND_POOL_PERCENT, 100);
  const patronageRefundPool = netSurplus - dividendPool;
  const shareRatio = totalShareCents > 0 ? memberShareCents / totalShareCents : 0;
  const dividend = totalShareCents > 0 ? mulDiv(dividendPool, memberShareCents, totalShareCents) : 0;
  return { netIncome: netIncomeCents, funds, statutoryTotal, netSurplus, dividendPool, patronageRefundPool, memberShare: memberShareCents, totalShare: totalShareCents, shareRatio, dividend };
}
