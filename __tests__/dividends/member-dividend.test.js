import { describe, test, expect } from '@jest/globals';
import { computeDividend } from '../../src/services/dividends.js';

const peso = (amount) => Math.round(amount * 100);

describe('A member\'s dividend on share capital (computeDividend: dividend)', () => {
  test('PHP 5,000 of PHP 100,000 share capital (5%) earns 5% of the PHP 35,000 pool', () => {
    const result = computeDividend({ netIncomeCents: peso(100000), memberShareCents: peso(5000), totalShareCents: peso(100000) });
    expect(result.shareRatio).toBe(0.05);
    expect(result.dividend).toBe(peso(1750));
  });

  test('a bigger share of the capital earns a bigger dividend', () => {
    const result = computeDividend({ netIncomeCents: peso(100000), memberShareCents: peso(10000), totalShareCents: peso(100000) });
    expect(result.dividend).toBe(peso(3500));
  });

  test('a member with no share capital gets no dividend', () => {
    expect(computeDividend({ netIncomeCents: peso(100000), memberShareCents: 0, totalShareCents: peso(100000) }).dividend).toBe(0);
  });

  test('when nobody has share capital, the dividend is zero, not an error', () => {
    const result = computeDividend({ netIncomeCents: peso(1000), memberShareCents: 0, totalShareCents: 0 });
    expect(result).toMatchObject({ shareRatio: 0, dividend: 0, dividendPool: peso(350) });
  });

  test('edge case: a share that does not divide evenly is rounded to the centavo', () => {
    const result = computeDividend({ netIncomeCents: 12345, memberShareCents: 1, totalShareCents: 3 });
    expect(result.dividend).toBe(Math.round(result.dividendPool / 3));
  });
});
