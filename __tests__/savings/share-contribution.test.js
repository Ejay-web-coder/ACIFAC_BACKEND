import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { addShareContribution } = await import('../../src/controllers/memberController.js');

// current: the member's share capital; others: everyone else's (PHP 90,000 allows the member PHP 10,000 in all).
function databaseHas({ status = 'active', current = '1000.00', others = '90000.00', duplicateReference = false } = {}) {
  answer(db.client.query, [
    ['SELECT id, member_number, status, membership_date FROM members', { rows: [{ id: 3, member_number: 'ACIFAC-2026-001', status }] }],
    ['AND LOWER(reference_number) = LOWER($2)', { rows: duplicateReference ? [{ '?column?': 1 }] : [] }],
    ['SELECT COALESCE(SUM(amount), 0) AS total FROM share_contributions', { rows: [{ total: current }] }],
    ['SELECT COALESCE(SUM(share_capital), 0) AS total FROM members', { rows: [{ total: others }] }],
    ['INSERT INTO share_contributions', (params) => ({ rows: [{ id: 7, memberId: params[0], amount: params[1], date: params[2] }] })],
    ['FROM share_contributions sc', { rows: [{ id: 7, amount: '500.00' }, { id: 1, amount: current }] }],
  ]);
}
const contribute = (body) => mockRequest({ method: 'POST', params: { id: '3' }, body: { amount: '500', contributionDate: '2026-11-02', paymentMethod: 'Cash', ...body }, user: ADMIN });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Share capital contribution (memberController.addShareContribution)', () => {
  test('records the contribution and returns the new total and what is left under the limit', async () => {
    const res = mockResponse();
    await addShareContribution(contribute(), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ message: 'Share contribution recorded.', contribution: { amount: 500 }, data: { total: 1500, maximum: 10000, remaining: 8500, maximumPercent: 10 } });
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE members SET share_capital'), ['1500.00', 3]);
  });

  test('refuses an amount that would pass 10% of the cooperative\'s share capital', async () => {
    await expect(addShareContribution(contribute({ amount: '9000.01' }), mockResponse())).rejects.toMatchObject({
      status: 400,
      message: "A member's share capital can't be more than 10% of the cooperative's total share capital. This member can hold at most PHP 10,000.00, so the most that can be added now is PHP 9,000.00.",
    });
  });

  test('rejects a missing amount or date, and an unknown payment method', async () => {
    await expect(addShareContribution(contribute({ amount: '' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Amount must be greater than zero with at most two decimals.' });
    await expect(addShareContribution(contribute({ contributionDate: '' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid contribution date (YYYY-MM-DD) is required.' });
    await expect(addShareContribution(contribute({ paymentMethod: 'Barter' }), mockResponse())).rejects.toMatchObject({ status: 400 });
  });

  test('the same receipt cannot be recorded twice', async () => {
    databaseHas({ duplicateReference: true });
    await expect(addShareContribution(contribute({ referenceNumber: 'OR-2001' }), mockResponse()))
      .rejects.toMatchObject({ status: 409, message: 'A contribution with this reference number was already recorded for this member.' });
  });

  test('a terminated member cannot add share capital', async () => {
    databaseHas({ status: 'archived' });
    await expect(addShareContribution(contribute(), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Contributions cannot be recorded for a member whose membership is terminated.' });
  });

  test('edge case: a member already at the limit can add nothing more', async () => {
    databaseHas({ current: '10000.00' });
    await expect(addShareContribution(contribute({ amount: '0.01' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('the most that can be added now is PHP 0.00') });
  });
});
