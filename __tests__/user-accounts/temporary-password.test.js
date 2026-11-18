import { describe, test, expect } from '@jest/globals';
import { generateTemporaryPassword, validatePasswordPolicy } from '../../src/utils/password.js';

describe('Temporary passwords (generateTemporaryPassword)', () => {
  test('makes a 10-character password that passes the password policy', () => {
    for (let index = 0; index < 200; index += 1) {
      const password = generateTemporaryPassword();
      expect(password).toHaveLength(10);
      expect(validatePasswordPolicy(password).isValid).toBe(true);
    }
  });

  test('never uses characters that are easy to misread (O/0, I/l/1)', () => {
    const all = Array.from({ length: 300 }, () => generateTemporaryPassword()).join('');
    expect(all).not.toMatch(/[O0Il1]/);
  });

  test('gives a different password every time', () => {
    const passwords = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(passwords.size).toBe(500);
  });

  test('edge case: a longer length is honoured and the policy still holds', () => {
    const password = generateTemporaryPassword(16);
    expect(password).toHaveLength(16);
    expect(validatePasswordPolicy(password).isValid).toBe(true);
  });
});
