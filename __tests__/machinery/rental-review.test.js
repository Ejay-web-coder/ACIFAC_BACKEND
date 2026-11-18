import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', mockEmailService);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { reviewRentalRequest } = await import('../../src/controllers/machineryController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

const day = (offset) => { const date = new Date(`${todayDateOnly()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const pending = () => ({ id: 15, status: 'pending', machinery_id: 'M-003', machinery_name: 'Water Pump', member_id: 3, member_name: 'Juan Dela Cruz', start_date: day(7), end_date: day(10), duration: 3, rental_fee: '2400.00', client_category: 'member' });
function databaseHas({ request = pending(), machineStatus = 'available', booked = null } = {}) {
  answer(db.client.query, [
    ['FROM rental_requests r JOIN machinery m', { rows: request ? [request] : [] }],
    ['SELECT status FROM machinery WHERE id = $1', { rows: [{ status: machineStatus }] }],
    ['FROM machinery_operations o', { rows: booked ? [booked] : [] }],
    ['SELECT id FROM users WHERE member_id = $1', { rows: [{ id: 7 }] }],
  ]);
}
const review = (status, id = 15) => mockRequest({ method: 'PATCH', params: { id: String(id) }, body: { status }, user: ADMIN });
const statements = () => db.client.query.mock.calls.map(([sql]) => sql);
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Rental request review (machineryController.reviewRentalRequest)', () => {
  test('approving a request schedules the machine for the member', async () => {
    const res = mockResponse();
    await reviewRentalRequest(review('approved'), res);
    expect(res.body).toEqual({ success: true, message: 'Rental request approved.' });
    expect(statements().some((sql) => sql.includes('INSERT INTO machinery_operations'))).toBe(true);
    // The member's notification (the status refresh before it inserts reminders without parameters).
    const [, params] = db.client.query.mock.calls.find(([sql, values]) => sql.includes('INSERT INTO notifications') && Array.isArray(values));
    expect(params[2]).toBe('Rental request approved');
  });

  test('declining a request books nothing and tells the member', async () => {
    const res = mockResponse();
    await reviewRentalRequest(review('declined'), res);
    expect(res.body.message).toBe('Rental request declined.');
    expect(statements().some((sql) => sql.includes('INSERT INTO machinery_operations'))).toBe(false);
  });

  test('rejects a status other than approved or declined', async () => {
    await expect(reviewRentalRequest(review('maybe'), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Invalid request status.' });
    await expect(reviewRentalRequest(review(undefined), mockResponse())).rejects.toMatchObject({ status: 400 });
  });

  test('a request is reviewed only once, and an unknown one is not found', async () => {
    databaseHas({ request: { ...pending(), status: 'approved' } });
    await expect(reviewRentalRequest(review('declined'), mockResponse())).rejects.toMatchObject({ status: 409, message: 'Rental request was already reviewed.' });
    databaseHas({ request: null });
    await expect(reviewRentalRequest(review('approved'), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Rental request not found.' });
  });

  test('a machine under maintenance or already booked cannot be approved', async () => {
    databaseHas({ machineStatus: 'maintenance' });
    await expect(reviewRentalRequest(review('approved'), mockResponse())).rejects.toMatchObject({ status: 409, message: 'This machine is under maintenance. Set it back to available before approving.' });
    databaseHas({ booked: { id: 3, start_date: day(8), end_date: day(9) } });
    await expect(reviewRentalRequest(review('approved'), mockResponse())).rejects.toMatchObject({ status: 409 });
  });

  test('edge case: a request whose dates have passed cannot be approved', async () => {
    databaseHas({ request: { ...pending(), start_date: day(-5), end_date: day(-1) } });
    await expect(reviewRentalRequest(review('approved'), mockResponse())).rejects.toMatchObject({ status: 400, message: "This request's rental period has already passed." });
  });
});
