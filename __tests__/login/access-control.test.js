import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { requireAuth, requireAdmin, requireMember, requireVendor } = await import('../../src/middleware/auth.js');
const { csrfProtection } = await import('../../src/middleware/security.js');

const liveSession = { session_id: 11, user_id: 7, username: 'juan.delacruz', role: 'MEMBER', member_id: 3, account_status: 'ACTIVE', must_change_password: false, idle_expired: false, activity_stale: false, idle_expires_in_seconds: 900, session_expires_in_seconds: 20000 };
function sessionIs(row) {
  db.module.query.mockImplementation(async (sql) => (sql.includes('FROM sessions s') ? { rows: row ? [row] : [] } : { rows: [], rowCount: 1 }));
}
const page = (originalUrl, extra = {}) => mockRequest({ cookies: { session_token: 'abc' }, originalUrl, ...extra });
beforeEach(() => { jest.clearAllMocks(); sessionIs(liveSession); });

describe('Access control (requireAuth, role guards, CSRF)', () => {
  test('a valid session lets the request through as that user', async () => {
    const req = page('/api/members/me');
    const next = jest.fn();
    await requireAuth(req, mockResponse(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: 7, role: 'MEMBER' });
  });

  test('no session cookie, or an ended session, is refused with 401', async () => {
    const res = mockResponse();
    await requireAuth(mockRequest({ originalUrl: '/api/members/me' }), res, jest.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('SESSION_INVALID');
    sessionIs(null);
    const ended = mockResponse();
    await requireAuth(page('/api/members/me'), ended, jest.fn());
    expect(ended.body.code).toBe('SESSION_INVALID');
  });

  test('a session idle for 20 minutes is ended', async () => {
    sessionIs({ ...liveSession, idle_expired: true });
    const res = mockResponse();
    await requireAuth(page('/api/members/me'), res, jest.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_IDLE_TIMEOUT', message: 'Your session expired because of inactivity. Please log in again.' });
  });

  test('a deactivated account is signed out', async () => {
    sessionIs({ ...liveSession, account_status: 'INACTIVE' });
    const res = mockResponse();
    await requireAuth(page('/api/members/me'), res, jest.fn());
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');
  });

  test('a temporary password must be changed before any other page', async () => {
    sessionIs({ ...liveSession, must_change_password: true });
    const blocked = mockResponse();
    await requireAuth(page('/api/loans'), blocked, jest.fn());
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const next = jest.fn();
    await requireAuth(page('/api/auth/change-password', { method: 'POST' }), mockResponse(), next);
    expect(next).toHaveBeenCalled();
  });

  test('admin pages are refused to members, vendors and signed-out users', () => {
    const next = jest.fn();
    requireAdmin({ user: { role: 'ADMIN' } }, mockResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
    for (const user of [{ role: 'MEMBER', member_id: 3 }, { role: 'VENDOR' }, undefined]) {
      const res = mockResponse();
      requireAdmin({ user }, res, next);
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toBe('Admin access required.');
    }
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('member pages need a member account linked to a member record', () => {
    const next = jest.fn();
    requireMember({ user: { role: 'MEMBER', member_id: 3 } }, mockResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const unlinked = mockResponse();
    requireMember({ user: { role: 'MEMBER', member_id: null } }, unlinked, next);
    expect(unlinked.statusCode).toBe(403);
    const vendorOnly = mockResponse();
    requireVendor({ user: { role: 'ADMIN' } }, vendorOnly, next);
    expect(vendorOnly.body.message).toBe('A Kadiwa vendor account is required.');
  });

  test('changes without the verification header or from another site are refused', () => {
    const next = jest.fn();
    csrfProtection(mockRequest({ method: 'GET' }), mockResponse(), next);
    csrfProtection(mockRequest({ method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: 'http://localhost:5173' } }), mockResponse(), next);
    expect(next).toHaveBeenCalledTimes(2);
    const missing = mockResponse();
    csrfProtection(mockRequest({ method: 'POST' }), missing, next);
    expect(missing.body.message).toBe('Missing request verification header.');
    const foreign = mockResponse();
    csrfProtection(mockRequest({ method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://evil.example' } }), foreign, next);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.body.message).toBe('Request origin is not allowed.');
  });
});
