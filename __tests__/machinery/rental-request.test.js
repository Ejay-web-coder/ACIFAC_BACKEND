import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', mockEmailService);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { createRentalRequest } = await import('../../src/controllers/machineryController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

const day = (offset) => { const date = new Date(`${todayDateOnly()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
function databaseHas({ machine = { id: 'M-003', name: 'Water Pump', daily_fee: '800.00', status: 'available' }, booked = null, member = { id: 3, full_name: 'Juan Dela Cruz' } } = {}) {
  answer(db.client.query, [
    ['FROM machinery WHERE id = $1 FOR UPDATE', { rows: machine ? [machine] : [] }],
    ['FROM machinery_operations o', { rows: booked ? [booked] : [] }],
    ['FROM members WHERE id = $1 AND status', { rows: member ? [member] : [] }],
    ['INSERT INTO rental_requests', { rows: [{ id: 15 }] }],
    ['WHERE r.id = $1', { rows: [{ id: 15, machineryName: 'Water Pump', memberDatabaseId: 3, rentalFee: '2400.00' }] }],
  ]);
}
const memberUser = { id: 7, username: 'juan', role: 'MEMBER', member_id: 3 };
const book = (body, user = memberUser) => mockRequest({ method: 'POST', body: { machineryId: 'M-003', purpose: 'Irrigate 2 ha of palay', startDate: day(7), endDate: day(10), ...body }, user });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Machine rental booking (machineryController.createRentalRequest)', () => {
  test('a member books an available machine; the fee is the daily fee times the days', async () => {
    const res = mockResponse();
    await createRentalRequest(book(), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.request).toMatchObject({ id: 15, machineryName: 'Water Pump' });
    const [sql, params] = db.client.query.mock.calls.find(([text]) => text.includes('INSERT INTO rental_requests'));
    expect(sql).toContain('$7::numeric * GREATEST(1, ($2::date - $1::date))');
    expect(params.slice(0, 7)).toEqual([day(7), day(10), 'M-003', 3, 'Juan Dela Cruz', 'Irrigate 2 ha of palay', '800.00']);
  });

  test('refuses dates that overlap a booking already made', async () => {
    databaseHas({ booked: { id: 2, start_date: day(9), end_date: day(12) } });
    await expect(createRentalRequest(book(), mockResponse())).rejects.toMatchObject({ status: 409, message: `This machine is already booked from ${day(9)} to ${day(12)}. Choose other dates.` });
  });

  test('rejects a missing purpose, an end before the start and a start in the past', async () => {
    await expect(createRentalRequest(book({ purpose: '' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Machinery, valid dates, and purpose are required.' });
    await expect(createRentalRequest(book({ endDate: day(6) }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'End date cannot be before the start date.' });
    await expect(createRentalRequest(book({ startDate: day(-1) }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Start date cannot be in the past.' });
  });

  test('a machine under maintenance, or one that does not exist, cannot be booked', async () => {
    databaseHas({ machine: { id: 'M-003', name: 'Water Pump', daily_fee: '800.00', status: 'maintenance' } });
    await expect(createRentalRequest(book(), mockResponse())).rejects.toMatchObject({ status: 409, message: 'That machinery is under maintenance and cannot be booked right now.' });
    databaseHas({ machine: null });
    await expect(createRentalRequest(book(), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Machinery not found.' });
  });

  test('only the office can book for a non-member, and needs the name', async () => {
    await expect(createRentalRequest(book({ clientCategory: 'non_member', clientName: 'Pedro Santos' }), mockResponse()))
      .rejects.toMatchObject({ status: 403, message: 'Only the cooperative office can record a rental for a non-member.' });
    await expect(createRentalRequest(book({ clientCategory: 'non_member' }, ADMIN), mockResponse())).rejects.toMatchObject({ status: 400, message: "Enter the non-member's full name." });
    const res = mockResponse();
    await createRentalRequest(book({ clientCategory: 'non_member', clientName: 'Pedro Santos' }, ADMIN), res);
    expect(res.statusCode).toBe(201);
  });

  test('edge case: a member whose membership is not active cannot book', async () => {
    databaseHas({ member: null });
    await expect(createRentalRequest(book(), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Active member record not found.' });
  });
});
