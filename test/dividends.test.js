// Unit tests for the dividend computation (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDividend, STATUTORY_PERCENT } from '../src/services/dividends.js';

const peso = (amount) => Math.round(amount * 100);

test('the worked example: PHP 100,000 net income, PHP 5,000 of PHP 100,000 share capital', () => {
  const result = computeDividend({ netIncomeCents: peso(100000), memberShareCents: peso(5000), totalShareCents: peso(100000) });
  assert.equal(STATUTORY_PERCENT, 30);
  assert.deepEqual(result.funds.map((fund) => [fund.label, fund.amount]), [
    ['Reserve Fund', peso(10000)], ['Education & Training Fund', peso(10000)], ['Community Development Fund', peso(3000)], ['Optional Fund', peso(7000)],
  ]);
  assert.equal(result.statutoryTotal, peso(30000));
  assert.equal(result.netSurplus, peso(70000));
  assert.equal(result.dividendPool, peso(35000));
  assert.equal(result.patronageRefundPool, peso(35000));
  assert.equal(result.shareRatio, 0.05);
  assert.equal(result.dividend, peso(1750));
});

test('every part is rounded to the centavo and the parts add up', () => {
  const result = computeDividend({ netIncomeCents: 12345, memberShareCents: 1, totalShareCents: 3 });
  assert.equal(result.funds.reduce((sum, fund) => sum + fund.amount, 0), result.statutoryTotal);
  assert.equal(result.statutoryTotal + result.netSurplus, 12345);
  assert.equal(result.dividendPool + result.patronageRefundPool, result.netSurplus);
  assert.equal(result.dividend, Math.round((result.dividendPool * 1) / 3));
  // Large amounts are exact (no floating point).
  const big = computeDividend({ netIncomeCents: 999_999_999_99, memberShareCents: 2_000_000, totalShareCents: 3_000_001 });
  assert.equal(big.statutoryTotal + big.netSurplus, 999_999_999_99);
  assert.ok(Number.isInteger(big.dividend));
});

test('no surplus is shared when there is no net income, and no share capital means no dividend', () => {
  for (const netIncomeCents of [0, -50000]) {
    const result = computeDividend({ netIncomeCents, memberShareCents: 1000, totalShareCents: 4000 });
    assert.equal(result.netIncome, netIncomeCents);
    assert.equal(result.statutoryTotal, 0);
    assert.equal(result.netSurplus, 0);
    assert.equal(result.dividend, 0);
  }
  const noCapital = computeDividend({ netIncomeCents: peso(1000), memberShareCents: 0, totalShareCents: 0 });
  assert.equal(noCapital.shareRatio, 0);
  assert.equal(noCapital.dividend, 0);
  assert.equal(noCapital.dividendPool, peso(350));
});
