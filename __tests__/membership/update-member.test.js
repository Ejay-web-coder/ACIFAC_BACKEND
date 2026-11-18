import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { updateMember } = await import('../../src/controllers/memberController.js');

const stored = { id: '55', member_number: 'ACIFAC-2026-004', first_name: 'Juan', last_name: 'Dela Cruz', status: 'active', share_capital: '1000.00' };
function databaseHas({ member = stored, duplicate = null } = {}) {
  answer(db.client.query, [
    ['FOR UPDATE OF m', { rows: member ? [member] : [] }],
    ['SELECT id, member_number FROM members', { rows: duplicate ? [duplicate] : [] }],
    ['FROM members m', { rows: [{ ...stored, phone: '09998887777' }] }],
  ]);
}
const form = { first_name: 'Juan', last_name: 'Dela Cruz', phone: '09998887777', address: 'Aliaga, Nueva Ecija', membership_date: '2026-01-15' };
const edit = (id, body = form) => mockRequest({ method: 'PUT', params: { id: String(id) }, body, user: { id: 1, username: 'admin', role: 'ADMIN' } });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Edit member (memberController.updateMember)', () => {
  test('saves the changed details and records them in the audit trail', async () => {
    const res = mockResponse();
    await updateMember(edit(55), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Member updated successfully.', data: { id: 55, phone: '09998887777' } });
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_logs'), expect.arrayContaining(['MEMBER_UPDATED']));
  });

  test('rejects invalid details before touching the database', async () => {
    await expect(updateMember(edit(55, { ...form, phone: '' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Phone number is required.' });
    expect(db.module.withTransaction).not.toHaveBeenCalled();
  });

  test('a member that does not exist is reported as not found', async () => {
    databaseHas({ member: null });
    await expect(updateMember(edit(404), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Member not found.' });
  });

  test('a terminated member must be restored before editing', async () => {
    databaseHas({ member: { ...stored, status: 'archived' } });
    await expect(updateMember(edit(55), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Restore this member before editing.' });
  });

  test('refuses details that belong to another member', async () => {
    databaseHas({ duplicate: { id: 12, member_number: 'ACIFAC-2025-012' } });
    await expect(updateMember(edit(55), mockResponse())).rejects.toMatchObject({
      status: 409,
      message: 'Another member (ACIFAC-2025-012) already uses this email, RSBSA number, or name and birth date.',
    });
  });
});
