import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer } from '../helpers/http.js';
import { allocatePayment, ensureInstallments } from '../../src/services/loanService.js';

// A PHP 30,000 loan at 15%: one installment of PHP 34,500 (PHP 4,500 interest).
const single = { id: 1, amount_due: '34500.00', amount_paid: '0.00', interest_due: '4500.00', interest_paid: '0.00', principal_due: '30000.00', principal_paid: '0.00' };
// An older loan repaid monthly: PHP 5,750 a month (PHP 750 interest).
const month = (id) => ({ id, amount_due: '5750.00', amount_paid: '0.00', interest_due: '750.00', interest_paid: '0.00', principal_due: '5000.00', principal_paid: '0.00' });
const client = { query: jest.fn() };
const openInstallments = (rows) => answer(client.query, [['FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due', { rows }]]);
const updates = () => client.query.mock.calls.filter(([sql]) => sql.includes('UPDATE loan_installments')).map(([, params]) => params);
beforeEach(() => client.query.mockReset());

describe('Payment allocation (loanService.allocatePayment)', () => {
  test('a payment covers the interest first, then the principal', async () => {
    openInstallments([single]);
    await expect(allocatePayment(client, 5, 500000, '2026-11-02')).resolves.toEqual({ interestCents: 450000, principalCents: 50000, unallocatedCents: 0 });
    expect(updates()).toEqual([[1, '5000.00', '4500.00', '500.00', '2026-11-02']]);
  });

  test('a small payment goes to interest only', async () => {
    openInstallments([single]);
    await expect(allocatePayment(client, 5, 200000, '2026-11-02')).resolves.toEqual({ interestCents: 200000, principalCents: 0, unallocatedCents: 0 });
  });

  test('the oldest installment is paid off before the next one', async () => {
    openInstallments([month(1), month(2)]);
    await expect(allocatePayment(client, 5, 600000, '2026-11-02')).resolves.toEqual({ interestCents: 100000, principalCents: 500000, unallocatedCents: 0 });
    expect(updates()).toEqual([[1, '5750.00', '750.00', '5000.00', '2026-11-02'], [2, '250.00', '250.00', '0.00', '2026-11-02']]);
  });

  test('a partly paid installment continues where it stopped', async () => {
    openInstallments([{ ...single, amount_paid: '4500.00', interest_paid: '4500.00' }]);
    await expect(allocatePayment(client, 5, 100000, '2026-11-02')).resolves.toEqual({ interestCents: 0, principalCents: 100000, unallocatedCents: 0 });
    expect(updates()[0][1]).toBe('5500.00');
  });

  test('edge case: money beyond what is owed is reported as unallocated', async () => {
    openInstallments([single]);
    await expect(allocatePayment(client, 5, 3500000, '2026-11-02')).resolves.toMatchObject({ unallocatedCents: 50000 });
    openInstallments([]);
    await expect(allocatePayment(client, 5, 100, '2026-11-02')).resolves.toEqual({ interestCents: 0, principalCents: 0, unallocatedCents: 100 });
  });

  test('a loan that already has a schedule is left as it is', async () => {
    answer(client.query, [['SELECT COUNT(*)::int AS count FROM loan_installments', { rows: [{ count: 1 }] }]]);
    await expect(ensureInstallments(client, 5)).resolves.toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('an old loan without a schedule gets one and its payments are replayed onto it', async () => {
    answer(client.query, [
      ['SELECT COUNT(*)::int AS count FROM loan_installments', { rows: [{ count: 0 }] }],
      ['FROM loans WHERE id = $1', { rows: [{ term: 6, date_approved: '2026-05-04', repayment: 'single', total: '34500.00', interest: '4500.00' }] }],
      ['SELECT amount, payment_date, penalty_paid FROM loan_payments', { rows: [{ amount: '5000.00', payment_date: '2026-07-01', penalty_paid: '0.00' }] }],
      ['FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due', { rows: [single] }],
    ]);
    await expect(ensureInstallments(client, 5)).resolves.toBe(true);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO loan_installments'), expect.arrayContaining([5, '34500.00', '4500.00', 6, '2026-05-04']));
    expect(updates()).toEqual([[1, '5000.00', '4500.00', '500.00', '2026-07-01']]);
  });
});
