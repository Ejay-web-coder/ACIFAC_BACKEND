import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { requireAuth, requireAdmin, requireMember, requireVendor } = await import('../../src/middleware/auth.js');
const { csrfProtection } = await import('../../src/middleware/security.js');

const liveSession = { session_id: 11, user_id: 7, username: 'juan.delacruz', role: 'MEMBER', member_id: 3, account_status: 'ACTIVE', must_change_password: false, locked: false, lock_recorded: false, activity_stale: false, idle_expires_in_seconds: 900, session_expires_in_seconds: 20000 };
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

  test('a session idle for 20 minutes is locked until the password is entered again', async () => {
    sessionIs({ ...liveSession, locked: true });
    const res = mockResponse();
    const next = jest.fn();
    await requireAuth(page('/api/members/me'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, code: 'SESSION_LOCKED', message: 'Your session was locked after 20 minutes without activity. Enter your password to continue.' });
    // The cookie stays, so the same session can go on after the password.
    expect(res.cleared).toEqual([]);
    expect(db.module.query).toHaveBeenCalledWith(expect.stringContaining('SET locked_at'), [11, 20]);
    expect(db.module.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO audit_logs'), expect.arrayContaining(['SESSION_LOCKED']));
  });

  test('edge case: the lock is recorded once, and the page reload gets whose session it is', async () => {
    db.module.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM sessions s')) return { rows: [{ ...liveSession, locked: true, lock_recorded: true }] };
      if (sql.includes('LEFT JOIN members m')) return { rows: [{ username: 'juan.delacruz', display_name: 'Juan Dela Cruz' }] };
      return { rows: [], rowCount: 1 };
    });
    const req = page('/api/auth/me');
    req.allowSignedOut = true;
    const res = mockResponse();
    await requireAuth(req, res, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ user: null, code: 'SESSION_LOCKED', locked: { username: 'juan.delacruz', display_name: 'Juan Dela Cruz', idleTimeoutSeconds: 1200 } });
    expect(db.module.query).not.toHaveBeenCalledWith(expect.stringContaining('SET locked_at'), expect.anything());
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
