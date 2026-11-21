import { jest, describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import bcrypt from 'bcryptjs';
import { mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

// The database, the lockout counter and the account lookup are mocked.
const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const throttle = {
  throttleKeys: { user: (id) => `user:${id}`, name: (name) => `name:${name}`, ip: (ip) => `ip:${ip}` },
  findActiveLock: jest.fn(),
  registerFailure: jest.fn(),
  clearFailures: jest.fn(),
};
jest.unstable_mockModule('../../src/services/loginThrottle.js', () => throttle);
jest.unstable_mockModule('../../src/services/accountLookup.js', () => ({
  findAccountsByEmail: jest.fn(async () => []),
  findAccountsByPhone: jest.fn(async () => []),
}));
const { unlockSession } = await import('../../src/controllers/authController.js');

// A member's session after 20 minutes without activity.
const lockedSession = { session_id: 11, user_id: 7, username: 'juan.delacruz', role: 'MEMBER', member_id: 3, account_status: 'ACTIVE', must_change_password: false, locked: true, lock_recorded: true, activity_stale: true, idle_expires_in_seconds: 0, session_expires_in_seconds: 20000 };
let passwordHash;
function sessionIs(row) {
  db.module.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM sessions s')) return { rows: row ? [row] : [] };
    if (sql.includes('SELECT password_hash FROM users')) return { rows: [{ password_hash: passwordHash }] };
    return { rows: [], rowCount: 1 };
  });
}
const stayLoggedIn = (password) => mockRequest({ method: 'POST', cookies: { session_token: 'abc' }, body: { password } });
const audited = (action) => db.module.query.mock.calls.some(([sql, params]) => sql.includes('INSERT INTO audit_logs') && params.includes(action));

beforeAll(async () => { passwordHash = await bcrypt.hash('Pass1234!', 4); });
beforeEach(() => {
  jest.clearAllMocks();
  throttle.findActiveLock.mockResolvedValue(null);
  throttle.registerFailure.mockResolvedValue({ locked: false, attemptsRemaining: 2 });
  sessionIs(lockedSession);
});

describe('Session lock after 20 minutes without activity (authController.unlockSession)', () => {
  test('the right password unlocks the session, which goes on as before', async () => {
    const res = mockResponse();
    await unlockSession(stayLoggedIn('Pass1234!'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Welcome back.', idleTimeoutSeconds: 1200, idleExpiresInSeconds: 1200, sessionExpiresInSeconds: 20000 });
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('SET locked_at = NULL, last_activity_at = NOW()'), [11]);
    expect(throttle.clearFailures).toHaveBeenCalledWith('user:7', db.client);
    // Same session: no new cookie, and the old one is kept.
    expect(res.cookies.session_token).toBeUndefined();
    expect(res.cleared).toEqual([]);
    expect(audited('SESSION_UNLOCKED')).toBe(true);
  });

  test('a wrong password keeps the session locked and says how many attempts are left', async () => {
    const res = mockResponse();
    await unlockSession(stayLoggedIn('WrongPass1!'), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, code: 'INVALID_PASSWORD', message: 'Incorrect password.', attemptsRemaining: 2 });
    expect(throttle.registerFailure).toHaveBeenCalledWith('user:7', expect.objectContaining({ maxAttempts: 3, lockMinutes: 20, userId: 7 }));
    expect(db.client.query).not.toHaveBeenCalledWith(expect.stringContaining('SET locked_at = NULL'), expect.anything());
    expect(audited('LOGIN_FAILURE')).toBe(true);
  });

  test('the third wrong password locks sign-in for 20 minutes, as on the login page', async () => {
    throttle.registerFailure.mockResolvedValueOnce({ locked: true, attemptsRemaining: 0, retryAfterSeconds: 1200, lockedUntil: '2026-11-21T10:20:00Z' });
    const res = mockResponse();
    await unlockSession(stayLoggedIn('WrongPass1!'), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1200');
    expect(res.body).toMatchObject({ code: 'LOGIN_LOCKED', message: 'Too many failed login attempts. Please try again in 20 minutes.', retryAfterSeconds: 1200 });
    expect(audited('LOGIN_LOCKED')).toBe(true);
  });

  test('edge case: while sign-in is locked, even the right password does not unlock', async () => {
    throttle.findActiveLock.mockResolvedValueOnce({ key: 'user:7', lockedUntil: '2026-11-21T10:20:00Z', retryAfterSeconds: 600 });
    const res = mockResponse();
    await unlockSession(stayLoggedIn('Pass1234!'), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code: 'LOGIN_LOCKED', retryAfterSeconds: 600 });
    // The password is not even checked, so a lock gives no hint whether a guess was right.
    expect(db.module.query).not.toHaveBeenCalledWith(expect.stringContaining('SELECT password_hash'), expect.anything());
    expect(db.client.query).not.toHaveBeenCalled();
  });

  test('edge case: an ended session or a deactivated account cannot be unlocked (back to the login page)', async () => {
    sessionIs(null);
    const ended = mockResponse();
    await unlockSession(stayLoggedIn('Pass1234!'), ended);
    expect(ended.statusCode).toBe(401);
    expect(ended.body).toMatchObject({ code: 'SESSION_INVALID', message: 'Your session has expired. Please log in again.' });
    expect(ended.cleared).toContain('session_token');

    sessionIs({ ...lockedSession, account_status: 'INACTIVE' });
    const inactive = mockResponse();
    await unlockSession(stayLoggedIn('Pass1234!'), inactive);
    expect(inactive.statusCode).toBe(401);
    expect(inactive.body.code).toBe('ACCOUNT_INACTIVE');
    expect(db.module.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1'), [7]);
  });

  test('a blank password is refused before anything is checked', async () => {
    await expect(unlockSession(stayLoggedIn(''), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Enter your password.' });
    expect(db.module.query).not.toHaveBeenCalled();
  });
});
