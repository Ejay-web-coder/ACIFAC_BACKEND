import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { logout } = await import('../../src/controllers/authController.js');
const { digestToken } = await import('../../src/utils/auth.js');

beforeEach(() => {
  jest.clearAllMocks();
  db.module.query.mockImplementation(async (sql) => (sql.includes('UPDATE sessions') ? { rows: [{ id: 7, username: 'juan.delacruz', role: 'MEMBER' }] } : { rows: [] }));
});

describe('Logout (authController.logout)', () => {
  test('ends the session, records the logout and clears the cookie', async () => {
    const res = mockResponse();
    await logout(mockRequest({ method: 'POST', cookies: { session_token: 'abc123' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Logged out successfully.' });
    expect(res.cleared).toContain('session_token');
    expect(db.module.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_logs'), expect.arrayContaining(['LOGOUT']));
  });

  test('looks the session up by its digest, never by the raw token', async () => {
    await logout(mockRequest({ method: 'POST', cookies: { session_token: 'abc123' } }), mockResponse());
    const [, params] = db.module.query.mock.calls.find(([sql]) => sql.includes('UPDATE sessions'));
    expect(params).toEqual([digestToken('abc123')]);
  });

  test('without a session cookie it still succeeds and touches nothing', async () => {
    const res = mockResponse();
    await logout(mockRequest({ method: 'POST' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.cleared).toContain('session_token');
    expect(db.module.query).not.toHaveBeenCalled();
  });

  test('an already-ended session is not logged out twice', async () => {
    db.module.query.mockResolvedValue({ rows: [] });
    const res = mockResponse();
    await logout(mockRequest({ method: 'POST', cookies: { session_token: 'expired' } }), res);
    expect(res.statusCode).toBe(200);
    expect(db.module.query).toHaveBeenCalledTimes(1);
  });
});
