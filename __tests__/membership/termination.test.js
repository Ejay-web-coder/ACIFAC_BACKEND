import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { archiveMember, restoreMember } = await import('../../src/controllers/memberController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

function memberIs(member) {
  answer(db.client.query, [
    ['SELECT id, member_number, status, archived_at, additional_info FROM members', { rows: member ? [member] : [] }],
    ["SET status = 'archived'", { rows: [{ id: 55, member_number: 'ACIFAC-2026-004', status: 'archived', archived_at: '2026-11-11T02:00:00Z', archived_by: 1 }] }],
    ["SET status = 'active'", { rows: [{ id: 55, member_number: 'ACIFAC-2026-004', status: 'active' }] }],
  ]);
}
const active = { id: 55, member_number: 'ACIFAC-2026-004', status: 'active', additional_info: { membershipType: 'Regular' } };
const terminated = { ...active, status: 'archived', additional_info: { membershipType: 'Regular', separationDate: '2026-10-01', termination: { type: 'voluntary' } } };
const request = (body = {}) => mockRequest({ method: 'POST', params: { id: '55' }, body, user: { id: 1, username: 'admin', role: 'ADMIN' } });
beforeEach(() => { jest.clearAllMocks(); memberIs(active); });

describe('Termination of membership (archiveMember, restoreMember)', () => {
  test('a voluntary termination moves the member to the terminated list with today\'s date', async () => {
    const res = mockResponse();
    await archiveMember(request({ terminationType: 'voluntary' }), res);
    expect(res.body).toMatchObject({ success: true, message: 'Membership terminated.', data: { status: 'archived', termination: { type: 'voluntary', date: todayDateOnly() } } });
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes("SET status = 'archived'"));
    expect(JSON.parse(params[2])).toMatchObject({ membershipType: 'Regular', separationDate: todayDateOnly() });
  });

  test('an involuntary termination needs one of the by-law causes', async () => {
    await expect(archiveMember(request({ terminationType: 'involuntary' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Choose the cause of the involuntary termination.' });
    const res = mockResponse();
    await archiveMember(request({ terminationType: 'involuntary', cause: 'noPatronage' }), res);
    expect(res.body.data.termination).toMatchObject({ type: 'involuntary', cause: 'noPatronage' });
  });

  test('a missing or unknown kind of termination is rejected', async () => {
    for (const body of [{}, { terminationType: 'expelled' }]) {
      await expect(archiveMember(request(body), mockResponse()))
        .rejects.toMatchObject({ status: 400, message: 'Choose the kind of termination: automatic, voluntary or involuntary.' });
    }
  });

  test('a member cannot be terminated twice', async () => {
    memberIs(terminated);
    await expect(archiveMember(request({ terminationType: 'automatic' }), mockResponse())).rejects.toMatchObject({ status: 409, message: 'Membership is already terminated.' });
  });

  test('restoring a member clears the termination and the separation date', async () => {
    memberIs(terminated);
    const res = mockResponse();
    await restoreMember(request(), res);
    expect(res.body).toMatchObject({ success: true, message: 'Member restored successfully.', data: { status: 'active', termination: null } });
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes("SET status = 'active'"));
    expect(JSON.parse(params[1])).toEqual({ membershipType: 'Regular' });
  });

  test('an active member cannot be restored, and an unknown member is not found', async () => {
    await expect(restoreMember(request(), mockResponse())).rejects.toMatchObject({ status: 409, message: 'Membership is not terminated.' });
    memberIs(null);
    await expect(archiveMember(request({ terminationType: 'voluntary' }), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Member not found.' });
  });
});
