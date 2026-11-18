import { jest, describe, test, expect } from '@jest/globals';
import { SHARE_CAPITAL_PERCENT_CAP, shareCapitalMaxCents } from '../../src/controllers/memberController.js';

// A database stand-in that reports everyone else's share capital.
const othersHold = (total) => ({ query: jest.fn(async () => ({ rows: [{ total }] })) });

describe('Share capital limit, 10% of the cooperative (shareCapitalMaxCents)', () => {
  test('with PHP 90,000 held by others a member may hold PHP 10,000 (10% of PHP 100,000)', async () => {
    expect(SHARE_CAPITAL_PERCENT_CAP).toBe(10);
    await expect(shareCapitalMaxCents(othersHold('90000.00'), 3)).resolves.toBe(1000000);
  });

  test('the member\'s own share capital is left out of "the others"', async () => {
    const db = othersHold('90000.00');
    await shareCapitalMaxCents(db, 3);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status <> 'archived' AND ($1::bigint IS NULL OR id <> $1)"), [3]);
  });

  test('a member not yet registered is compared with every member', async () => {
    const db = othersHold('45000.00');
    await expect(shareCapitalMaxCents(db)).resolves.toBe(500000);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [null]);
  });

  test('with no other share capital, a member may hold nothing', async () => {
    await expect(shareCapitalMaxCents(othersHold('0'), 3)).resolves.toBe(0);
  });

  test('edge case: the limit is rounded down to the centavo', async () => {
    await expect(shareCapitalMaxCents(othersHold('1.00'), 3)).resolves.toBe(11);
  });
});
