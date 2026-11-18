import { jest, describe, test, expect } from '@jest/globals';
import { calculateLoanFinancials, LOAN_POLICY } from '../../src/services/loanService.js';

const quoteDb = () => ({ query: jest.fn(async () => ({ rows: [{ maximum_eligible_amount: '100000.00' }] })) });

describe('Loan policy (LOAN_POLICY, calculateLoanFinancials)', () => {
  test('the policy is PHP 50,000 per hectare at 2.5% a month for 6 months (15%)', () => {
    expect(LOAN_POLICY).toMatchObject({ maxLoanPerHectare: '50000', monthlyInterestRate: '2.5', interestRate: '15', loanTerm: 6, repayment: 'single', renewalMinPaidPercent: 80 });
  });

  test('a quote sends the farm area, the per-hectare limit, the amount and the 15% rate', async () => {
    const db = quoteDb();
    await calculateLoanFinancials(db, { farmArea: '2', amount: '30000', term: 6 });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('maximum_eligible_amount'), ['2', '50000', '30000', '15', 1]);
  });

  test('a single-payment loan is due as one installment of the whole total', async () => {
    const db = quoteDb();
    await calculateLoanFinancials(db, { farmArea: '1', amount: '10000', term: 6, single: true });
    expect(db.query.mock.calls[0][1][4]).toBe(1);
  });

  test('older monthly loans divide the total over the term', async () => {
    const db = quoteDb();
    await calculateLoanFinancials(db, { farmArea: '1', amount: '10000', term: 6, interestRate: '8', single: false });
    expect(db.query.mock.calls[0][1]).toEqual(['1', '50000', '10000', '8', 6]);
  });

  test('edge case: a member with no farm area recorded is quoted a maximum of zero hectares', async () => {
    const db = quoteDb();
    await calculateLoanFinancials(db, { farmArea: null, amount: '10000', term: 6 });
    expect(db.query.mock.calls[0][1][0]).toBe(0);
  });
});
