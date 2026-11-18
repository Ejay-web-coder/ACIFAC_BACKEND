import { describe, test, expect } from '@jest/globals';
import bcrypt from 'bcryptjs';
import {
  buildAuthCookieOptions, digestToken, generateSecureToken, generateVerificationCode, matchSessionToken, sanitizeUser, SESSION_TTL_MS,
} from '../../src/utils/auth.js';

describe('Session tokens and cookies', () => {
  test('a new session token is 64 random hex characters', () => {
    const first = generateSecureToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(generateSecureToken()).not.toBe(first);
  });

  test('the stored digest matches the token it was made from', async () => {
    const token = generateSecureToken();
    await expect(matchSessionToken(token, digestToken(token))).resolves.toBe(true);
  });

  test('a different token is rejected', async () => {
    await expect(matchSessionToken(generateSecureToken(), digestToken(generateSecureToken()))).resolves.toBe(false);
  });

  test('a missing token or a missing stored hash is rejected', async () => {
    await expect(matchSessionToken('', digestToken('abc'))).resolves.toBe(false);
    await expect(matchSessionToken('abc', null)).resolves.toBe(false);
  });

  test('older bcrypt-hashed session tokens are still recognised', async () => {
    const legacy = await bcrypt.hash('old-token', 4);
    await expect(matchSessionToken('old-token', legacy)).resolves.toBe(true);
    await expect(matchSessionToken('other-token', legacy)).resolves.toBe(false);
  });

  test('the session cookie is httpOnly and lasts 8 hours', () => {
    const options = buildAuthCookieOptions();
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS });
    expect(SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
    expect(buildAuthCookieOptions({ includeMaxAge: false })).not.toHaveProperty('maxAge');
  });

  test('user data sent to the browser never contains password or token hashes', () => {
    const safe = sanitizeUser({ id: 1, username: 'juan', password_hash: 'x', reset_token_hash: 'y', token_digest: 'z' });
    expect(safe).toEqual({ id: 1, username: 'juan' });
    expect(sanitizeUser(null)).toBeNull();
  });

  test('password reset codes are exactly six digits', () => {
    for (let index = 0; index < 200; index += 1) expect(generateVerificationCode()).toMatch(/^\d{6}$/);
  });
});
