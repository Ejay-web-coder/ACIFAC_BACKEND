import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', mockEmailService);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { recordPayment } = await import('../../src/controllers/loanController.js');
const { LOAN_POLICY, penaltyDue } = await import('../../src/services/loanService.js');
const { loanDecisionEmail, paymentEmail } = await import('../../src/services/emailTemplates.js');

// A PHP 30,000 loan at 15%, PHP 34,500 due on May 4, 2026: the grace period
// ended May 9, so on May 21 it is 12 days into the penalty (PHP 1,200).
const loan = { id: 5, loan_number: 'L-2026-005', member_id: 3, date_approved: '2025-11-03', balance: '34500.00', status: 'overdue' };
const installment = { id: 1, amount_due: '34500.00', amount_paid: '0.00', interest_due: '4500.00', interest_paid: '0.00', principal_due: '30000.00', principal_paid: '0.00' };
function databaseHas({ penalty = { penalty_due: '1200.00', penalty_days: 12 }, after = { balance: '30700.00', status: 'overdue' } } = {}) {
  const states = [{ balance: '34500.00', status: 'overdue' }, after];
  answer(db.client.query, [
    ['SELECT * FROM loans WHERE id = $1 FOR UPDATE', { rows: [loan] }],
    ['SELECT COUNT(*)::int AS count FROM loan_installments', { rows: [{ count: 1 }] }],
    ['WITH totals AS', () => ({ rows: [states.shift() ?? after] })],
    ['AS penalty_due', { rows: [penalty] }],
    ['FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due', { rows: [installment] }],
    ['INSERT INTO loan_payments', { rows: [{ id: 91 }] }],
    ['SELECT id FROM users WHERE member_id = $1', { rows: [{ id: 7 }] }],
    ['FROM loan_payments p', { rows: [{ id: 91, loanNumber: 'L-2026-005', amount: '5000.00', penaltyPaid: '1200.00', remainingBalance: '30700.00' }] }],
  ]);
}
const pay = (amount, paymentDate = '2026-05-21') => mockRequest({ method: 'POST', params: { id: '5' }, body: { amount, paymentDate }, user: ADMIN });
const insertedPayment = () => db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO loan_payments'))[1];
const memberNotice = () => db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'))[1][3];
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Late payment penalty (5-day grace period, then PHP 100 a day)', () => {
  test('the policy: a 5-day grace period after the due date, then PHP 100 a day', () => {
    expect(LOAN_POLICY).toMatchObject({ loanTerm: 6, gracePeriodDays: 5, penaltyPerDay: '100' });
  });

  test('the penalty due is read as of the payment date, in centavos with its days', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ penalty_due: '1200.00', penalty_days: 12 }] })) };
    await expect(penaltyDue(client, 5, '2026-05-21')).resolves.toEqual({ cents: 120000, days: 12 });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('grace_days'), [5, '2026-05-21']);
  });

  test('a payment pays the penalty first, then interest, then principal', async () => {
    const res = mockResponse();
    await recordPayment(pay('5000'), res);
    expect(res.statusCode).toBe(201);
    // PHP 5,000: PHP 1,200 penalty, PHP 3,800 interest, nothing to principal; PHP 30,700 still owed.
    expect(insertedPayment()).toEqual([5, '5000.00', '2026-05-21', '0.00', '3800.00', '30700.00', 1, '1200.00']);
    expect(memberNotice()).toBe('Your payment of PHP 5,000.00 for loan L-2026-005 was recorded (PHP 1,200.00 of it for the late penalty). Remaining balance: PHP 30,700.00.');
  });

  test('the whole amount due is the balance and the penalty; more is refused', async () => {
    await expect(recordPayment(pay('35700.01'), mockResponse())).rejects.toMatchObject({
      status: 400, message: 'Payment cannot exceed PHP 35700.00: the balance of PHP 34500.00 and the late penalty of PHP 1200.00 (12 days).',
    });
    databaseHas({ after: { balance: '0.00', status: 'paid' } });
    await recordPayment(pay('35700'), mockResponse());
    expect(insertedPayment()).toEqual([5, '35700.00', '2026-05-21', '30000.00', '4500.00', '0.00', 1, '1200.00']);
  });

  test('a payment smaller than the penalty pays only penalty, and the rest is still due', async () => {
    databaseHas({ after: { balance: '34500.00', status: 'overdue' } });
    await recordPayment(pay('500'), mockResponse());
    expect(insertedPayment()).toEqual([5, '500.00', '2026-05-21', '0.00', '0.00', '34500.00', 1, '500.00']);
    expect(memberNotice()).toMatch(/Late penalty still due: PHP 700\.00\.$/);
  });

  test('within the grace period nothing is charged', async () => {
    databaseHas({ penalty: { penalty_due: '0.00', penalty_days: 0 }, after: { balance: '29500.00', status: 'overdue' } });
    await recordPayment(pay('5000', '2026-05-08'), mockResponse());
    expect(insertedPayment()).toEqual([5, '5000.00', '2026-05-08', '500.00', '4500.00', '29500.00', 1, '0.00']);
    databaseHas({ penalty: { penalty_due: '0.00', penalty_days: 0 } });
    await expect(recordPayment(pay('34500.01', '2026-05-08'), mockResponse())).rejects.toMatchObject({ message: 'Payment cannot exceed the outstanding balance of PHP 34500.00.' });
  });

  test('the approval email states the penalty; the payment email shows what paid it', () => {
    const approved = loanDecisionEmail({ requestId: 'LR-2026-014', amount: '30000', interestRate: '15', term: 6, status: 'approved', totalRepayment: '34500', repayment: 'single', dueDate: '2027-05-11', penaltyPerDay: '100', graceDays: 5 });
    expect(approved.text).toContain('due by May 11, 2027\nLate payment: after a 5-day grace period, a penalty of PHP 100.00 a day until paid in full');
    expect(paymentEmail({ memberName: 'Juan Dela Cruz', amount: '5000', paymentDate: '2026-05-21', loanNumber: 'L-2026-005', remainingBalance: '30700', penaltyPaid: '1200', status: 'recorded' }).text)
      .toBe('Hello Juan Dela Cruz, your payment of PHP 5,000.00 for loan L-2026-005 was recorded on 2026-05-21 (PHP 1,200.00 of it for the late penalty). Remaining balance: PHP 30,700.00.');
  });
});
