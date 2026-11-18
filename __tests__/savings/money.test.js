import { describe, test, expect } from '@jest/globals';
import { centsToString, parseMoneyInput, toCents } from '../../src/utils/money.js';

describe('Money amounts in centavos (toCents, centsToString, parseMoneyInput)', () => {
  test('reads amounts exactly, without floating-point errors', () => {
    expect(toCents('1500.50')).toBe(150050);
    expect(toCents('0.10') + toCents('0.20')).toBe(30);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('2000.000')).toBe(200000);
  });

  test('writes centavos back as a two-decimal amount', () => {
    expect(centsToString(150050)).toBe('1500.50');
    expect(centsToString(5)).toBe('0.05');
    expect(centsToString(-2550)).toBe('-25.50');
  });

  test('accepts a typed amount with up to two decimals', () => {
    expect(parseMoneyInput('500')).toBe(50000);
    expect(parseMoneyInput('1250.5')).toBe(125050);
    expect(parseMoneyInput(75)).toBe(7500);
  });

  test('rejects text, negatives and more than two decimals', () => {
    for (const value of ['abc', '-100', '10.555', '1,000', '₱500']) expect(parseMoneyInput(value)).toBeNull();
    expect(() => toCents('abc')).toThrow('Invalid money value: abc');
  });

  test('a blank amount counts as zero, and zero is refused unless allowed', () => {
    expect(toCents('')).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('0')).toBeNull();
    expect(parseMoneyInput('0', { allowZero: true })).toBe(0);
  });

  test('edge case: amounts above the PHP 100,000,000 ceiling are refused', () => {
    expect(parseMoneyInput('100000000')).toBe(10000000000);
    expect(parseMoneyInput('100000000.01')).toBeNull();
  });
});
