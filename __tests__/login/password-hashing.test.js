import { describe, test, expect, beforeAll } from '@jest/globals';
import { hashPassword, verifyPassword } from '../../src/utils/password.js';

describe('Password hashing (hashPassword, verifyPassword)', () => {
  let hash;
  beforeAll(async () => { hash = await hashPassword('Pass1234!'); }, 30000);

  test('stores a salted bcrypt hash (cost 12), never the plain password', () => {
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain('Pass1234!');
  });

  test('accepts the correct password', async () => {
    await expect(verifyPassword('Pass1234!', hash)).resolves.toBe(true);
  });

  test('rejects a wrong password', async () => {
    await expect(verifyPassword('Pass1234?', hash)).resolves.toBe(false);
  });

  test('rejects an empty password', async () => {
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  test('edge case: the same password hashed twice gives two different hashes', async () => {
    const second = await hashPassword('Pass1234!');
    expect(second).not.toBe(hash);
    await expect(verifyPassword('Pass1234!', second)).resolves.toBe(true);
  }, 30000);
});
