import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', () => mockEmailService());
const { createMemberAccount } = await import('../../src/controllers/adminController.js');
const { validatePasswordPolicy } = await import('../../src/utils/password.js');

const activeMember = { id: 3, member_number: 'ACF-2026-001', first_name: 'Juan', last_name: 'Dela Cruz', email: 'juan@example.com', phone: '09171234567', status: 'active' };
// The member record and the accounts the database already has.
function databaseHas({ member = activeMember, existingAccount = false, emailTaken = false } = {}) {
  answer(db.client.query, [
    ['FROM members WHERE id = $1 FOR UPDATE', { rows: member ? [member] : [] }],
    ['SELECT id FROM users WHERE member_id = $1', { rows: existingAccount ? [{ id: 99 }] : [] }],
    ['WHERE LOWER(u.email) = $1', { rows: emailTaken ? [{ id: 50, email: 'juan@example.com', member_name: 'Pedro Penduko' }] : [] }],
    ['INSERT INTO users', (params) => ({ rows: [{ id: 21, member_id: params[0], username: params[1], email: params[2], password_hash: params[3], role: 'MEMBER' }] })],
  ]);
}
const admin = { id: 1, username: 'admin', role: 'ADMIN' };
const request = (body) => mockRequest({ method: 'POST', body, user: admin });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Create member account (adminController.createMemberAccount)', () => {
  test('creates the account with a generated temporary password', async () => {
    const res = mockResponse();
    await createMemberAccount(request({ memberId: 3 }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Member account created successfully.', username: 'acf-2026-001' });
    expect(validatePasswordPolicy(res.body.temporaryPassword).isValid).toBe(true);
    expect(res.body.user).not.toHaveProperty('password_hash');
  }, 30000);

  test('stores only the hash of the password and forces a change at first sign-in', async () => {
    const res = mockResponse();
    await createMemberAccount(request({ memberId: 3 }), res);
    const [sql, params] = db.client.query.mock.calls.find(([text]) => text.includes('INSERT INTO users'));
    expect(sql).toContain("'ACTIVE', TRUE");
    expect(params[3]).toMatch(/^\$2[aby]\$12\$/);
    expect(params[3]).not.toBe(res.body.temporaryPassword);
  }, 30000);

  test('rejects passwords that do not match', async () => {
    await expect(createMemberAccount(request({ memberId: 3, password: 'Pass1234!', confirmPassword: 'Pass1234?' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Passwords do not match.' });
  });

  test('rejects a missing member or a weak password', async () => {
    await expect(createMemberAccount(request({}), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid member ID is required.' });
    await expect(createMemberAccount(request({ memberId: 3, password: 'weak', confirmPassword: 'weak' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Password must be at least 8 characters long.' });
  });

  test('refuses a member who is not active', async () => {
    databaseHas({ member: { ...activeMember, status: 'inactive' } });
    await expect(createMemberAccount(request({ memberId: 3 }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Accounts can only be created for active members.' });
  }, 30000);

  test('refuses a second account for the same member', async () => {
    databaseHas({ existingAccount: true });
    await expect(createMemberAccount(request({ memberId: 3 }), mockResponse()))
      .rejects.toMatchObject({ status: 409, message: 'A login account already exists for this member.' });
  }, 30000);

  test('refuses an email that another account already signs in with', async () => {
    databaseHas({ emailTaken: true });
    await expect(createMemberAccount(request({ memberId: 3 }), mockResponse()))
      .rejects.toMatchObject({ status: 409, message: "Another account (Pedro Penduko) already uses this member's email address." });
  }, 30000);

  test('refuses a member with neither an email nor a mobile number', async () => {
    databaseHas({ member: { ...activeMember, email: '', phone: '' } });
    await expect(createMemberAccount(request({ memberId: 3 }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: "Add the member's email or mobile number in their member information first: they sign in with it." });
  }, 30000);
});
