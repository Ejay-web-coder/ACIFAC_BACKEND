import { jest, describe, test, expect } from '@jest/globals';
import { SHARE_CAPITAL_PERCENT_CAP, shareCapitalLimit, shareCapitalMaxCents } from '../../src/controllers/memberController.js';

// A database stand-in that reports the cooperative's total share capital.
const cooperativeHolds = (total) => ({ query: jest.fn(async () => ({ rows: [{ total }] })) });

describe('Share capital limit, 10% of the cooperative (shareCapitalMaxCents)', () => {
  test('with PHP 100,000 in all, a member may hold PHP 10,000 (10%)', async () => {
    expect(SHARE_CAPITAL_PERCENT_CAP).toBe(10);
    await expect(shareCapitalMaxCents(cooperativeHolds('100000.00'))).resolves.toBe(1000000);
  });

  test('every member has the same maximum: the total of every member is used, none left out', async () => {
    const db = cooperativeHolds('100000.00');
    await shareCapitalMaxCents(db);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toBe("SELECT COALESCE(SUM(share_capital), 0) AS total FROM members WHERE status <> 'archived'");
    expect(params).toBeUndefined();
  });

  test('gives the total with the maximum, for the member pages', async () => {
    await expect(shareCapitalLimit(cooperativeHolds('45000.00'))).resolves.toEqual({ totalCents: 4500000, maxCents: 450000 });
  });

  test('with no share capital in the cooperative, a member may hold nothing', async () => {
    await expect(shareCapitalMaxCents(cooperativeHolds('0'))).resolves.toBe(0);
  });

  test('edge case: the limit is rounded down to the centavo', async () => {
    await expect(shareCapitalMaxCents(cooperativeHolds('1.05'))).resolves.toBe(10);
  });
});
