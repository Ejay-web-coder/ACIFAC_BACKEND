import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { updateAccountStatus } = await import('../../src/controllers/adminController.js');

function accountIs(account, { otherActiveAdmins = 1 } = {}) {
  answer(db.client.query, [
    ['FROM users WHERE id = $1 FOR UPDATE', { rows: account ? [account] : [] }],
    ["role = 'ADMIN' AND account_status = 'ACTIVE' AND id <> $1", { rows: [{ count: otherActiveAdmins }] }],
    ['UPDATE users SET account_status', (params) => ({ rows: [{ ...account, account_status: params[0], password_hash: 'secret' }] })],
    ['UPDATE sessions SET revoked_at', { rows: [], rowCount: 2 }],
  ]);
}
const change = (id, status) => mockRequest({ method: 'PATCH', params: { id: String(id) }, body: { status }, user: { id: 1, username: 'admin', role: 'ADMIN' } });
const member = { id: 9, username: 'juan.delacruz', role: 'MEMBER', account_status: 'ACTIVE' };
beforeEach(() => { jest.clearAllMocks(); accountIs(member); });

describe('Account status (adminController.updateAccountStatus)', () => {
  test('deactivates a member account and ends its open sessions', async () => {
    const res = mockResponse();
    await updateAccountStatus(change(9, 'INACTIVE'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Account status updated.', account: { account_status: 'INACTIVE' } });
    expect(res.body.account).not.toHaveProperty('password_hash');
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions SET revoked_at'), [9]);
  });

  test('reactivating an account does not touch its sessions', async () => {
    accountIs({ ...member, account_status: 'INACTIVE' });
    await updateAccountStatus(change(9, 'ACTIVE'), mockResponse());
    expect(db.client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions'), expect.anything());
  });

  test('rejects an unknown status', async () => {
    await expect(updateAccountStatus(change(9, 'DELETED'), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Status must be ACTIVE, INACTIVE, or LOCKED.' });
  });

  test('rejects a missing status or an invalid account ID', async () => {
    await expect(updateAccountStatus(change(9, undefined), mockResponse())).rejects.toMatchObject({ status: 400 });
    await expect(updateAccountStatus(change('abc', 'INACTIVE'), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'A valid account ID is required.' });
  });

  test('an administrator cannot switch off their own account', async () => {
    await expect(updateAccountStatus(change(1, 'INACTIVE'), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'You cannot change your own account status.' });
  });

  test('the only active administrator cannot be switched off', async () => {
    accountIs({ id: 2, username: 'chair', role: 'ADMIN', account_status: 'ACTIVE' }, { otherActiveAdmins: 0 });
    await expect(updateAccountStatus(change(2, 'LOCKED'), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'This is the only active administrator, so it cannot be switched off.' });
  });

  test('an account that does not exist is reported as not found', async () => {
    accountIs(null);
    await expect(updateAccountStatus(change(404, 'INACTIVE'), mockResponse()))
      .rejects.toMatchObject({ status: 404, message: 'Account not found.' });
  });
});
