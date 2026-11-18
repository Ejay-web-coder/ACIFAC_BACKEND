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
const { login } = await import('../../src/controllers/authController.js');

let member;
// The account the sign-in lookup finds (null: no account has that name).
function accountIs(user) {
  db.module.query.mockImplementation(async (sql) => (sql.includes('LOWER(u.username) = LOWER($1)') ? { rows: user ? [user] : [] } : { rows: [], rowCount: 1 }));
}
const signIn = (usernameOrEmail, password) => mockRequest({ method: 'POST', body: { usernameOrEmail, password } });

beforeAll(async () => {
  member = { id: 7, member_id: 3, username: 'juan.delacruz', email: 'juan@example.com', role: 'MEMBER', account_status: 'ACTIVE', must_change_password: false, password_hash: await bcrypt.hash('Pass1234!', 4) };
});
beforeEach(() => {
  jest.clearAllMocks();
  throttle.findActiveLock.mockResolvedValue(null);
  throttle.registerFailure.mockResolvedValue({ locked: false, attemptsRemaining: 2 });
  accountIs(member);
});

describe('Login (authController.login)', () => {
  test('accepts the correct username and password and opens a session', async () => {
    const res = mockResponse();
    await login(signIn('juan.delacruz', 'Pass1234!'), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Login successful.', role: 'MEMBER' });
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(res.cookies.session_token.options.httpOnly).toBe(true);
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sessions'), expect.any(Array));
    expect(throttle.clearFailures).toHaveBeenCalledWith('user:7', db.client);
  });

  test('rejects a wrong password with an error message and the attempts left', async () => {
    const res = mockResponse();
    await login(signIn('juan.delacruz', 'WrongPass1!'), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email, mobile number or password.', attemptsRemaining: 2 });
    expect(res.cookies.session_token).toBeUndefined();
  });

  test('rejects a blank username or a blank password', async () => {
    await expect(login(signIn('', ''), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Email or mobile number and password are required.' });
    await expect(login(signIn('juan.delacruz', ''), mockResponse())).rejects.toMatchObject({ status: 400 });
    expect(db.module.query).not.toHaveBeenCalled();
  });

  test('gives the same message for an account that does not exist', async () => {
    accountIs(null);
    const res = mockResponse();
    await login(signIn('nobody@example.com', 'Pass1234!'), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid email, mobile number or password.');
    expect(throttle.registerFailure).toHaveBeenCalledWith('name:nobody@example.com', expect.objectContaining({ maxAttempts: 3 }));
  }, 30000);

  test('the third wrong password locks the account for 20 minutes', async () => {
    throttle.registerFailure.mockResolvedValueOnce({ locked: true, attemptsRemaining: 0, retryAfterSeconds: 1200, lockedUntil: '2026-11-11T10:20:00Z' });
    const res = mockResponse();
    await login(signIn('juan.delacruz', 'WrongPass1!'), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1200');
    expect(res.body).toMatchObject({ code: 'LOGIN_LOCKED', message: 'Too many failed login attempts. Please try again in 20 minutes.' });
  });

  test('a locked account stays blocked even with the right password', async () => {
    throttle.findActiveLock.mockResolvedValue({ key: 'user:7', retryAfterSeconds: 300, lockedUntil: '2026-11-11T10:05:00Z' });
    const res = mockResponse();
    await login(signIn('juan.delacruz', 'Pass1234!'), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.message).toBe('Too many failed login attempts. Please try again in 5 minutes.');
    expect(db.module.withTransaction).not.toHaveBeenCalled();
  });

  test('an inactive account cannot log in, even with the right password', async () => {
    accountIs({ ...member, account_status: 'INACTIVE' });
    const res = mockResponse();
    await login(signIn('juan.delacruz', 'Pass1234!'), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Your account is inactive or locked. Please contact the ACIFAC office.');
    expect(res.cookies.session_token).toBeUndefined();
  });
});
