import { jest, describe, test, expect } from '@jest/globals';
import { centsToNumber, netIncomeCents } from '../../src/services/netIncome.js';

// A database stand-in that returns the income of each module for the period.
const incomeOf = (row) => ({ query: jest.fn(async () => ({ rows: [{ kadiwa: '0', rentalFees: '0', serviceFees: '0', otherIncome: '0', expenses: '0', loanInterest: '0', ...row }] })) });

describe('Cooperative net income (netIncomeCents)', () => {
  test('adds Kadiwa net sales, machinery income less its expenses, and loan interest', async () => {
    const db = incomeOf({ kadiwa: '25000.00', rentalFees: '12000.00', serviceFees: '18500.00', otherIncome: '500.00', expenses: '7000.00', loanInterest: '51000.00' });
    await expect(netIncomeCents({}, db)).resolves.toEqual({ total: 10000000, parts: { kadiwa: 2500000, machinery: 2400000, loans: 5100000 } });
    expect(centsToNumber(10000000)).toBe(100000);
  });

  test('passes the period dates to the database', async () => {
    const db = incomeOf({});
    await netIncomeCents({ from: '2026-01-01', to: '2026-06-30' }, db);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['2026-01-01', '2026-06-30']);
  });

  test('no dates means all time; no income means zero', async () => {
    const db = incomeOf({});
    await expect(netIncomeCents(undefined, db)).resolves.toEqual({ total: 0, parts: { kadiwa: 0, machinery: 0, loans: 0 } });
    expect(db.query.mock.calls[0][1]).toEqual([null, null]);
  });

  test('edge case: machinery expenses above its income give a negative machinery part', async () => {
    await expect(netIncomeCents({}, incomeOf({ serviceFees: '1000.00', expenses: '3000.00', loanInterest: '500.00' }))).resolves.toEqual({ total: -150000, parts: { kadiwa: 0, machinery: -200000, loans: 50000 } });
  });
});
