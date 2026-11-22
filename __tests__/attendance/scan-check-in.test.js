import { describe, test, expect } from '@jest/globals';
import { checkInStatus, idCardQrText, parseIdCardCode } from '../../src/services/idCards.js';
import { nowClock } from '../../src/utils/dates.js';

const CODE = '7f3a9c0e1b2d4f6a8c0e2b4d6f8a0c1e';

describe('Member ID QR codes (parseIdCardCode)', () => {
  test('the QR holds "ACIFAC:" and the member\'s code, nothing else', () => {
    expect(idCardQrText(CODE)).toBe(`ACIFAC:${CODE.toUpperCase()}`);
    expect(parseIdCardCode(idCardQrText(CODE))).toBe(CODE);
  });

  test('reads a code with or without "ACIFAC:", in any letter case', () => {
    expect(parseIdCardCode(CODE)).toBe(CODE);
    expect(parseIdCardCode(` acifac:${CODE.toUpperCase()} `)).toBe(CODE);
  });

  test('rejects QR codes that are not an ACIFAC member ID', () => {
    expect(parseIdCardCode('https://example.com')).toBeNull();
    expect(parseIdCardCode(`ACIFAC:${CODE.slice(1)}`)).toBeNull();
    expect(parseIdCardCode(`ACIFAC:${CODE.replace('7', 'z')}`)).toBeNull();
  });

  test('edge case: blank or missing values are rejected', () => {
    expect(parseIdCardCode('')).toBeNull();
    expect(parseIdCardCode('ACIFAC:')).toBeNull();
    expect(parseIdCardCode(undefined)).toBeNull();
  });
});

describe('Scan check-in: present or late (checkInStatus)', () => {
  test('a member who arrives by the start time is present', () => {
    expect(checkInStatus('07:50', '08:00')).toBe('present');
    expect(checkInStatus('08:00', '08:00:00')).toBe('present');
  });

  test('a member who arrives after the start time is late', () => {
    expect(checkInStatus('08:01', '08:00')).toBe('late');
    expect(checkInStatus('10:15', '08:00:00')).toBe('late');
  });

  test('the check-in time is the time in Manila', () => {
    expect(nowClock(new Date('2026-11-22T00:05:00Z'))).toBe('08:05');
    expect(nowClock(new Date('2026-11-22T16:00:00Z'))).toBe('00:00');
  });
});
