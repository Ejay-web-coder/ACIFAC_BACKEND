import { describe, test, expect } from '@jest/globals';
import { maskPhilippineMobile, normalizePhilippineMobile } from '../../src/utils/phone.js';

describe('Philippine mobile numbers (normalizePhilippineMobile, maskPhilippineMobile)', () => {
  test('a number typed in any common way becomes +639XXXXXXXXX', () => {
    for (const typed of ['09171234567', '0917 123 4567', '639171234567', '+63 917-123-4567', '9171234567', '(0917) 123.4567']) {
      expect(normalizePhilippineMobile(typed)).toBe('+639171234567');
    }
  });

  test('landlines, short numbers and two numbers in one field are refused', () => {
    expect(normalizePhilippineMobile('(02) 8123 4567')).toBeNull();
    expect(normalizePhilippineMobile('0917123456')).toBeNull();
    expect(normalizePhilippineMobile('09171234567 / 09181234567')).toBeNull();
  });

  test('a blank or missing number is refused', () => {
    expect(normalizePhilippineMobile('')).toBeNull();
    expect(normalizePhilippineMobile(undefined)).toBeNull();
  });

  test('the number is shown with its middle digits hidden', () => {
    expect(maskPhilippineMobile('+63 917 123 4567')).toBe('0917 ••• 4567');
    expect(maskPhilippineMobile('0918-555-0902')).toBe('0918 ••• 0902');
  });

  test('edge case: a number that is not a mobile is not masked', () => {
    expect(maskPhilippineMobile('(02) 8123 4567')).toBeNull();
  });
});
