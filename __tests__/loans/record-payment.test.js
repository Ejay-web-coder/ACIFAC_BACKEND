import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', mockEmailService);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { recordPayment } = await import('../../src/controllers/loanController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

const loan = { id: 5, loan_number: 'L-2026-005', member_id: 3, date_approved: '2026-06-01', balance: '34500.00', status: 'active' };
const installment = { id: 1, amount_due: '34500.00', amount_paid: '0.00', interest_due: '4500.00', interest_paid: '0.00', principal_due: '30000.00', principal_paid: '0.00' };
// states: what recomputeLoanState reports before and after the payment.
function databaseHas({ found = loan, states = [{ balance: '34500.00', status: 'active' }, { balance: '29500.00', status: 'active' }] } = {}) {
  const queue = [...states];
  answer(db.client.query, [
    ['SELECT * FROM loans WHERE id = $1 FOR UPDATE', { rows: found ? [found] : [] }],
    ['SELECT COUNT(*)::int AS count FROM loan_installments', { rows: [{ count: 1 }] }],
    ['WITH totals AS', () => ({ rows: [queue.shift() ?? states.at(-1)] })],
    ['FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due', { rows: [installment] }],
    ['INSERT INTO loan_payments', { rows: [{ id: 90 }] }],
    ['SELECT id FROM users WHERE member_id = $1', { rows: [{ id: 7 }] }],
    ['FROM loan_payments p', { rows: [{ id: 90, loanNumber: 'L-2026-005', amount: '5000.00', remainingBalance: '29500.00' }] }],
  ]);
}
const pay = (amount, paymentDate = '2026-11-02', id = 5) => mockRequest({ method: 'POST', params: { id: String(id) }, body: { amount, paymentDate }, user: ADMIN });
const notificationTitle = () => db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'))[1][2];
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Record loan payment (loanController.recordPayment)', () => {
  test('records the payment, split into interest and principal, with the new balance', async () => {
    const res = mockResponse();
    await recordPayment(pay('5000'), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, payment: { id: 90, remainingBalance: '29500.00' } });
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO loan_payments'));
    expect(params).toEqual([5, '5000.00', '2026-11-02', '500.00', '4500.00', '29500.00', 1, '0.00']);
    expect(notificationTitle()).toBe('Payment recorded');
  });

  test('the last payment marks the loan as fully paid', async () => {
    databaseHas({ states: [{ balance: '34500.00', status: 'active' }, { balance: '0.00', status: 'paid' }] });
    await recordPayment(pay('34500'), mockResponse());
    expect(notificationTitle()).toBe('Loan fully paid');
  });

  test('refuses a payment larger than the outstanding balance', async () => {
    await expect(recordPayment(pay('34500.01'), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Payment cannot exceed the outstanding balance of PHP 34500.00.' });
  });

  test('rejects a blank amount, a missing date and a future date', async () => {
    await expect(recordPayment(pay(''), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Payment amount must be greater than zero with at most two decimals.' });
    await expect(recordPayment(pay('500', ''), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid payment date (YYYY-MM-DD) is required.' });
    await expect(recordPayment(pay('500', `${Number(todayDateOnly().slice(0, 4)) + 1}-01-01`), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Payment date cannot be in the future.' });
  });

  test('a payment cannot be dated before the loan was approved', async () => {
    await expect(recordPayment(pay('500', '2026-05-31'), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Payment date cannot be before the loan approval date.' });
  });

  test('a fully paid loan takes no more payments', async () => {
    databaseHas({ states: [{ balance: '0.00', status: 'paid' }] });
    await expect(recordPayment(pay('100'), mockResponse())).rejects.toMatchObject({ status: 400, message: 'This loan is already fully paid.' });
  });

  test('an unknown loan is reported as not found', async () => {
    databaseHas({ found: null });
    await expect(recordPayment(pay('100'), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Loan not found.' });
    await expect(recordPayment(pay('100', '2026-11-02', 'x'), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid loan ID is required.' });
  });
});
