import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { createSavingsRecord } = await import('../../src/controllers/memberController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

function databaseHas({ member = { id: 3, member_number: 'ACIFAC-2026-001', status: 'active' }, balance = '1500.00', duplicateReference = false } = {}) {
  answer(db.client.query, [
    ['SELECT id, member_number, status FROM members WHERE id = $1 FOR UPDATE', { rows: member ? [member] : [] }],
    ['AND LOWER(reference_number) = LOWER($2)', { rows: duplicateReference ? [{ '?column?': 1 }] : [] }],
    ['AS total FROM savings_transactions', { rows: [{ total: balance }] }],
    ['SELECT id FROM users WHERE member_id = $1', { rows: [{ id: 7 }] }],
    ['INSERT INTO savings_transactions', (params) => ({ rows: [{ id: 40, memberId: params[0], amount: params[2], date: params[3], paymentMethod: params[4], reference: params[5] }] })],
  ]);
}
const deposit = (body) => mockRequest({ method: 'POST', body: { memberId: 3, amount: '500', date: '2026-11-02', ...body }, user: ADMIN });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Savings deposit (memberController.createSavingsRecord)', () => {
  test('records the deposit and returns the new balance', async () => {
    const res = mockResponse();
    await createSavingsRecord(deposit({ reference: 'OR-1001' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Savings recorded.', memberTotal: 2000, data: { amount: 500, type: 'Deposit', status: 'Completed', paymentMethod: 'Deposit' } });
  });

  test('the member is notified with the amount and the new total', async () => {
    await createSavingsRecord(deposit(), mockResponse());
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
    expect(params[0]).toEqual([7]);
    expect(params[3]).toBe('A savings deposit of PHP 500.00 was recorded. Your total savings are PHP 2,000.00.');
  });

  test('rejects a zero, negative or badly written amount', async () => {
    for (const amount of ['0', '-50', '12.345', '']) {
      await expect(createSavingsRecord(deposit({ amount }), mockResponse()))
        .rejects.toMatchObject({ status: 400, message: 'Amount must be greater than zero with at most two decimals.' });
    }
  });

  test('rejects a missing member, a missing date or a future date', async () => {
    await expect(createSavingsRecord(deposit({ memberId: undefined }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid member is required.' });
    await expect(createSavingsRecord(deposit({ date: '' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid date (YYYY-MM-DD) is required.' });
    await expect(createSavingsRecord(deposit({ date: `${Number(todayDateOnly().slice(0, 4)) + 1}-01-01` }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Savings date cannot be in the future.' });
  });

  test('rejects a payment method that is not on the list', async () => {
    await expect(createSavingsRecord(deposit({ paymentMethod: 'Crypto' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Payment method must be one of: Cash, Deposit, GCash, Bank Transfer, Check, Other.' });
  });

  test('a receipt number cannot be recorded twice for the same member', async () => {
    databaseHas({ duplicateReference: true });
    await expect(createSavingsRecord(deposit({ reference: 'OR-1001' }), mockResponse()))
      .rejects.toMatchObject({ status: 409, message: 'A savings record with this reference number already exists for this member.' });
  });

  test('a terminated member cannot deposit, and an unknown member is not found', async () => {
    databaseHas({ member: { id: 3, member_number: 'ACIFAC-2026-001', status: 'archived' } });
    await expect(createSavingsRecord(deposit(), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Savings cannot be recorded for a member whose membership is terminated.' });
    databaseHas({ member: null });
    await expect(createSavingsRecord(deposit(), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Member not found.' });
  });
});
