import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { mockDatabase } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { throttleKeys, findActiveLock, registerFailure, clearFailures } = await import('../../src/services/loginThrottle.js');

const LIMITS = { maxAttempts: 3, lockMinutes: 20 };
// The failed-attempt count the database reports after this failure.
function attemptsAfterFailure(count) {
  db.client.query.mockImplementation(async (sql) => {
    if (sql.includes('RETURNING failed_attempts')) return { rows: [{ failed_attempts: count }] };
    if (sql.includes('locked_until = NOW()')) return { rows: [{ locked_until: '2026-11-11T10:20:00Z', retry_after_seconds: 1200 }] };
    return { rows: [] };
  });
}
beforeEach(() => jest.clearAllMocks());

describe('Login lockout (loginThrottle)', () => {
  test('the first wrong password leaves 2 attempts', async () => {
    attemptsAfterFailure(1);
    await expect(registerFailure('user:7', LIMITS)).resolves.toEqual({ locked: false, attemptsRemaining: 2 });
  });

  test('the third wrong password locks the account for 20 minutes', async () => {
    attemptsAfterFailure(3);
    const outcome = await registerFailure('user:7', LIMITS);
    expect(outcome).toMatchObject({ locked: true, attemptsRemaining: 0, retryAfterSeconds: 1200 });
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('locked_until = NOW()'), ['user:7', 20]);
  });

  test('no lock is reported when the database has none', async () => {
    db.module.query.mockResolvedValueOnce({ rows: [] });
    await expect(findActiveLock(['user:7', 'ip:127.0.0.1'])).resolves.toBeNull();
  });

  test('an active lock is reported with at least 1 second to wait', async () => {
    db.module.query.mockResolvedValueOnce({ rows: [{ throttle_key: 'user:7', locked_until: '2026-11-11T10:20:00Z', retry_after_seconds: 0 }] });
    await expect(findActiveLock(['user:7'])).resolves.toEqual({ key: 'user:7', lockedUntil: '2026-11-11T10:20:00Z', retryAfterSeconds: 1 });
  });

  test('unknown sign-in names are counted case-insensitively and stored only as a digest', () => {
    const key = throttleKeys.name('  Juan@Example.com ');
    expect(key).toBe(throttleKeys.name('juan@example.com'));
    expect(key).toMatch(/^name:[a-f0-9]{64}$/);
    expect(key).not.toContain('juan');
  });

  test('a request without an address is counted under "unknown"', () => {
    expect(throttleKeys.ip(undefined)).toBe('ip:unknown');
    expect(throttleKeys.ip('x'.repeat(300))).toHaveLength(103);
  });

  test('a successful login clears the count', async () => {
    await clearFailures('user:7', db.client);
    expect(db.client.query).toHaveBeenCalledWith('DELETE FROM login_throttles WHERE throttle_key = $1', ['user:7']);
  });
});
