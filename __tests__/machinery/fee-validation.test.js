import { describe, test, expect } from '@jest/globals';
import { computeServiceFee, FeeInputError, fromScaled, toScaled } from '../../src/services/machineryFees.js';

describe('Machinery fee input checks (toScaled, fromScaled, FeeInputError)', () => {
  test('decimals are read exactly as scaled whole numbers', () => {
    expect(toScaled('1.5', 4, 'Area')).toBe(15000n);
    expect(toScaled(3800, 2, 'Rate')).toBe(380000n);
    expect(fromScaled(570000n, 2)).toBe('5700.00');
    expect(fromScaled(5n, 2)).toBe('0.05');
  });

  test('negative or non-numeric values are refused with a clear message', () => {
    expect(() => toScaled('-1', 2, 'Rate')).toThrow('Rate must be a number that is zero or more.');
    expect(() => toScaled('abc', 4, 'Area (ha)')).toThrow(FeeInputError);
  });

  test('blank values and zero quantities are refused', () => {
    expect(() => computeServiceFee({ unit: 'per_ha', rate: '', areaHa: '1' })).toThrow('Rate must be a number that is zero or more.');
    expect(() => computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '0' })).toThrow('Area (ha) must be more than zero.');
    expect(() => computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: '0', bagValue: '1000' })).toThrow('Total bags must be more than zero.');
  });

  test('days must be a whole number of at least one', () => {
    for (const days of [0, 1.5, 'two']) expect(() => computeServiceFee({ unit: 'per_day', rate: '800', days })).toThrow('Days must be a whole number of at least 1.');
  });

  test('a harvest fee needs the bag value, or kilos per bag and the price per kilo', () => {
    expect(() => computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: 100 })).toThrow('Enter the value of one bag, or kg per bag and the price per kg.');
    expect(() => computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: 100, kgPerBag: '50' })).toThrow(FeeInputError);
  });

  test('edge case: too many decimal places and unknown rate units are refused', () => {
    expect(() => computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '1.23456' })).toThrow('Area (ha) allows at most 4 decimal places.');
    expect(() => computeServiceFee({ unit: 'per_hour', rate: '500' })).toThrow('Unknown rate unit.');
  });
});
