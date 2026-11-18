import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { resetMemberPassword } = await import('../../src/controllers/adminController.js');
const { validatePasswordPolicy } = await import('../../src/utils/password.js');

const memberAccount = { id: 9, username: 'acf-2026-001', role: 'MEMBER', email: 'juan@example.com', member_number: 'ACF-2026-001', member_phone: '09171234567', member_name: 'Juan Dela Cruz', must_change_password: false };
function accountIs(account) {
  answer(db.client.query, [['FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = $1', { rows: account ? [account] : [] }]]);
}
const reset = (id) => mockRequest({ method: 'POST', params: { id: String(id) }, user: { id: 1, username: 'admin', role: 'ADMIN' } });
beforeEach(() => { jest.clearAllMocks(); accountIs(memberAccount); });

describe('Reset member password (adminController.resetMemberPassword)', () => {
  test('gives the member a new temporary password that passes the policy', async () => {
    const res = mockResponse();
    await resetMemberPassword(reset(9), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe("Juan Dela Cruz's password was reset. The temporary password is in your notifications.");
    expect(validatePasswordPolicy(res.body.temporaryPassword).isValid).toBe(true);
  }, 30000);

  test('signs the member out everywhere and requires a new password at sign-in', async () => {
    await resetMemberPassword(reset(9), mockResponse());
    const statements = db.client.query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes('must_change_password = TRUE'))).toBe(true);
    expect(statements.some((sql) => sql.includes('UPDATE sessions SET revoked_at'))).toBe(true);
    expect(statements.some((sql) => sql.includes('UPDATE password_reset_tokens SET used_at'))).toBe(true);
  }, 30000);

  test('the temporary password goes only to the admin who reset it', async () => {
    const res = mockResponse();
    await resetMemberPassword(reset(9), res);
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
    expect(params[0]).toEqual([1]);
    expect(params[3]).toContain(`Temporary password: ${res.body.temporaryPassword}`);
  }, 30000);

  test('rejects an invalid account ID', async () => {
    await expect(resetMemberPassword(reset('abc'), mockResponse())).rejects.toMatchObject({ status: 400, message: 'A valid account ID is required.' });
  });

  test('an account that does not exist is reported as not found', async () => {
    accountIs(null);
    await expect(resetMemberPassword(reset(404), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Account not found.' });
  }, 30000);

  test('an administrator password cannot be reset from here', async () => {
    accountIs({ ...memberAccount, role: 'ADMIN' });
    await expect(resetMemberPassword(reset(9), mockResponse()))
      .rejects.toMatchObject({ status: 403, message: 'Only member passwords can be reset from the admin console.' });
  }, 30000);
});
