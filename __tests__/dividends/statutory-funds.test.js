import { describe, test, expect } from '@jest/globals';
import { computeDividend, STATUTORY_PERCENT } from '../../src/services/dividends.js';

const peso = (amount) => Math.round(amount * 100);
const run = (netIncome) => computeDividend({ netIncomeCents: peso(netIncome), memberShareCents: peso(5000), totalShareCents: peso(100000) });

describe('Statutory funds from net income (computeDividend: funds and surplus)', () => {
  test('30% of PHP 100,000 net income goes to the four statutory funds', () => {
    const result = run(100000);
    expect(STATUTORY_PERCENT).toBe(30);
    expect(result.funds.map((fund) => [fund.label, fund.amount])).toEqual([
      ['Reserve Fund', peso(10000)], ['Education & Training Fund', peso(10000)], ['Community Development Fund', peso(3000)], ['Optional Fund', peso(7000)],
    ]);
    expect(result.statutoryTotal).toBe(peso(30000));
  });

  test('the remaining 70% is the net surplus, shared half as dividends and half as patronage refund', () => {
    expect(run(100000)).toMatchObject({ netSurplus: peso(70000), dividendPool: peso(35000), patronageRefundPool: peso(35000) });
  });

  test('every part is in whole centavos and the parts add up to the net income', () => {
    const result = computeDividend({ netIncomeCents: 12345, memberShareCents: 1, totalShareCents: 3 });
    expect(result.funds.reduce((sum, fund) => sum + fund.amount, 0)).toBe(result.statutoryTotal);
    expect(result.statutoryTotal + result.netSurplus).toBe(12345);
    expect(result.dividendPool + result.patronageRefundPool).toBe(result.netSurplus);
  });

  test('a year without net income, or with a loss, sets nothing aside', () => {
    for (const netIncome of [0, -500]) expect(run(netIncome)).toMatchObject({ statutoryTotal: 0, netSurplus: 0, dividendPool: 0, dividend: 0 });
  });

  test('edge case: very large amounts stay exact', () => {
    const big = computeDividend({ netIncomeCents: 999_999_999_99, memberShareCents: 2_000_000, totalShareCents: 3_000_001 });
    expect(big.statutoryTotal + big.netSurplus).toBe(999_999_999_99);
    expect(Number.isInteger(big.dividend)).toBe(true);
  });
});
