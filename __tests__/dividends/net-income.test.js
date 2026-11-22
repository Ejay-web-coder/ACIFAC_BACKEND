import { jest, describe, test, expect } from '@jest/globals';
import { centsToNumber, netIncomeCents } from '../../src/services/netIncome.js';

// A database stand-in that returns the income of each module for the period.
const incomeOf = (row) => ({ query: jest.fn(async () => ({ rows: [{ kadiwa: '0', rentalFees: '0', serviceFees: '0', otherIncome: '0', expenses: '0', loanInterest: '0', membershipFees: '0', duesFines: '0', recordedOther: '0', ...row }] })) });

describe('Cooperative net income (netIncomeCents)', () => {
  test('adds Kadiwa net sales, machinery income less its expenses, and loan interest', async () => {
    const db = incomeOf({ kadiwa: '25000.00', rentalFees: '12000.00', serviceFees: '18500.00', otherIncome: '500.00', expenses: '7000.00', loanInterest: '51000.00' });
    await expect(netIncomeCents({}, db)).resolves.toEqual({ total: 10000000, parts: { kadiwa: 2500000, machinery: 2400000, loans: 5100000, others: 0 }, others: { membershipFees: 0, duesFines: 0, recorded: 0 } });
    expect(centsToNumber(10000000)).toBe(100000);
  });

  test('passes the period dates to the database', async () => {
    const db = incomeOf({});
    await netIncomeCents({ from: '2026-01-01', to: '2026-06-30' }, db);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), ['2026-01-01', '2026-06-30']);
  });

  test('no dates means all time; no income means zero', async () => {
    const db = incomeOf({});
    await expect(netIncomeCents(undefined, db)).resolves.toEqual({ total: 0, parts: { kadiwa: 0, machinery: 0, loans: 0, others: 0 }, others: { membershipFees: 0, duesFines: 0, recorded: 0 } });
    expect(db.query.mock.calls[0][1]).toEqual([null, null]);
  });

  test('others: membership fees, absence fines and transfer fees collected, and other income the office recorded', async () => {
    const db = incomeOf({ loanInterest: '1000.00', membershipFees: '1500.00', duesFines: '750.00', recordedOther: '20000.00' });
    await expect(netIncomeCents({}, db)).resolves.toEqual({
      total: 2325000, parts: { kadiwa: 0, machinery: 0, loans: 100000, others: 2225000 }, others: { membershipFees: 150000, duesFines: 75000, recorded: 2000000 },
    });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain("d.kind IN ('absence_fine', 'transfer_fee')");
    expect(sql).toContain("additional_info ->> 'membershipFee'");
    expect(sql).toContain('FROM other_income');
  });

  test('edge case: machinery expenses above its income give a negative machinery part', async () => {
    await expect(netIncomeCents({}, incomeOf({ serviceFees: '1000.00', expenses: '3000.00', loanInterest: '500.00' }))).resolves.toEqual({ total: -150000, parts: { kadiwa: 0, machinery: -200000, loans: 50000, others: 0 }, others: { membershipFees: 0, duesFines: 0, recorded: 0 } });
  });
});
