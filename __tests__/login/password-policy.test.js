import { describe, test, expect } from '@jest/globals';
import { validatePasswordPolicy } from '../../src/utils/password.js';

describe('Password policy (validatePasswordPolicy)', () => {
  test('accepts a strong password', () => {
    expect(validatePasswordPolicy('Pass1234!')).toEqual({ isValid: true, errors: [] });
  });

  test('rejects a password without an uppercase letter and says why', () => {
    const result = validatePasswordPolicy('pass1234!');
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(['Password must contain at least one uppercase letter.']);
  });

  test('rejects a password without a number and a special character', () => {
    const result = validatePasswordPolicy('Password');
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual([
      'Password must contain at least one number.',
      'Password must contain at least one special character.',
    ]);
  });

  test('rejects an empty or missing password with every rule listed', () => {
    for (const value of ['', undefined, null]) {
      const result = validatePasswordPolicy(value);
      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(5);
    }
  });

  test('edge case: 7 characters are rejected, 8 characters are accepted', () => {
    expect(validatePasswordPolicy('Pa1!xyz').errors).toEqual(['Password must be at least 8 characters long.']);
    expect(validatePasswordPolicy('Pa1!xyzw').isValid).toBe(true);
  });
});
