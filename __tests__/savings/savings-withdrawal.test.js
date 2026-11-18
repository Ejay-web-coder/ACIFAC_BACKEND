import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { createSavingsWithdrawal } = await import('../../src/controllers/memberController.js');

// balance: savings now; availableOnDate: the balance on the withdrawal's date.
function databaseHas({ status = 'active', balance = '2000.00', availableOnDate = balance } = {}) {
  answer(db.client.query, [
    ['SELECT id, member_number, status FROM members WHERE id = $1 FOR UPDATE', { rows: [{ id: 3, member_number: 'ACIFAC-2026-001', status }] }],
    ['WITH running AS', { rows: [{ available: availableOnDate }] }],
    ['AS total FROM savings_transactions', { rows: [{ total: balance }] }],
    ['INSERT INTO savings_transactions', (params) => ({ rows: [{ id: 41, memberId: params[0], amount: params[2], date: params[3] }] })],
  ]);
}
const withdraw = (amount, date = '2026-11-02') => mockRequest({ method: 'POST', body: { memberId: 3, amount, date }, user: ADMIN });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Savings withdrawal (memberController.createSavingsWithdrawal)', () => {
  test('withdraws an amount that leaves the PHP 500 maintaining balance', async () => {
    const res = mockResponse();
    await createSavingsWithdrawal(withdraw('1500'), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ message: 'Withdrawal recorded.', memberTotal: 500, data: { type: 'Withdrawal', amount: 1500 } });
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO savings_transactions'));
    expect(params.slice(1, 5)).toEqual(['withdrawal', '1500.00', '2026-11-02', 'Cash']);
  });

  test('refuses a withdrawal that would go below the maintaining balance', async () => {
    await expect(createSavingsWithdrawal(withdraw('1500.01'), mockResponse())).rejects.toMatchObject({
      status: 400,
      message: "PHP 500.00 must stay in the member's savings. With a balance of PHP 2,000.00, the most that can be withdrawn is PHP 1,500.00.",
    });
  });

  test('rejects a blank or zero withdrawal', async () => {
    for (const amount of ['', '0']) {
      await expect(createSavingsWithdrawal(withdraw(amount), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Amount must be greater than zero with at most two decimals.' });
    }
  });

  test('a back-dated withdrawal is checked against the balance on that date', async () => {
    databaseHas({ balance: '2000.00', availableOnDate: '600.00' });
    await expect(createSavingsWithdrawal(withdraw('200', '2026-03-01'), mockResponse())).rejects.toMatchObject({
      status: 400,
      message: "On 2026-03-01 the member's savings balance was only PHP 600.00, and PHP 500.00 must stay in savings. Use a later date or a smaller amount.",
    });
  });

  test('a terminated member can be paid out the whole balance', async () => {
    databaseHas({ status: 'archived' });
    const res = mockResponse();
    await createSavingsWithdrawal(withdraw('2000'), res);
    expect(res.body.memberTotal).toBe(0);
  });

  test('edge case: even a terminated member cannot take out more than the balance', async () => {
    databaseHas({ status: 'archived' });
    await expect(createSavingsWithdrawal(withdraw('2000.01'), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: "The withdrawal is more than the member's savings balance of PHP 2,000.00." });
  });
});
