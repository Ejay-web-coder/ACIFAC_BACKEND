import { describe, test, expect } from '@jest/globals';
import { parseShareCapital, readAdditionalInfo } from '../../src/controllers/memberController.js';

describe('Membership form details (readAdditionalInfo, parseShareCapital)', () => {
  test('keeps the known membership form details as plain text', () => {
    const info = readAdditionalInfo({ motherMaidenName: 'Santos', membershipType: 'Regular', orNumber: 10234, children: [{ name: 'Ana', age: 7 }] });
    expect(info).toEqual({ motherMaidenName: 'Santos', membershipType: 'Regular', orNumber: '10234', children: [{ name: 'Ana', age: '7' }] });
  });

  test('reads details sent as JSON text from a form upload', () => {
    expect(readAdditionalInfo('{"bodResolution":"BR-2026-05","incomeSources":[{"source":"Palay","amount":"60000"}]}'))
      .toEqual({ bodResolution: 'BR-2026-05', incomeSources: [{ source: 'Palay', amount: '60000' }] });
  });

  test('rejects details that are not valid JSON or not an object', () => {
    expect(() => readAdditionalInfo('{not json')).toThrow('Additional member information is not valid.');
    expect(() => readAdditionalInfo(['a', 'b'])).toThrow('Additional member information is not valid.');
  });

  test('missing details, unknown keys and blank children rows are left out', () => {
    expect(readAdditionalInfo(undefined)).toEqual({});
    expect(readAdditionalInfo('')).toEqual({});
    expect(readAdditionalInfo({ hacker: 'x', children: [{ name: '', age: '' }] })).toEqual({});
  });

  test('share capital is read in centavos; blank means none', () => {
    const errors = [];
    expect(parseShareCapital({ share_capital: '1500.50' }, errors)).toBe(150050);
    expect(parseShareCapital({ share_capital: '' }, errors)).toBe(0);
    expect(parseShareCapital({}, errors)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('negative amounts or more than two decimals are refused', () => {
    for (const share_capital of ['-500', '10.555', 'one thousand']) {
      const errors = [];
      expect(parseShareCapital({ share_capital }, errors)).toBeNull();
      expect(errors).toEqual(['Share capital must be a non-negative amount with up to two decimals.']);
    }
  });
});
