import { describe, test, expect } from '@jest/globals';
import { computeServiceFee } from '../../src/services/machineryFees.js';

describe('Machinery service fees (computeServiceFee)', () => {
  test('per hectare: 1.5 ha of rotavator work at PHP 3,800 is PHP 5,700', () => {
    expect(computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '1.5' })).toEqual({ rateUsed: '3800.00', feeBags: null, bagValue: null, feeAmount: '5700.00' });
  });

  test('per hectare is exact for small fractions of a hectare', () => {
    expect(computeServiceFee({ unit: 'per_ha', rate: '3400', areaHa: '0.0125' }).feeAmount).toBe('42.50');
    expect(computeServiceFee({ unit: 'per_ha', rate: '3333.33', areaHa: '0.3333' }).feeAmount).toBe('1111.00');
  });

  test('per day: 3 days of the water pump at PHP 800 a day', () => {
    expect(computeServiceFee({ unit: 'per_day', rate: '800', days: 3 }).feeAmount).toBe('2400.00');
  });

  test('harvest: 10 bags out of 100 for a member, valued at PHP 1,000 a bag', () => {
    expect(computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: 100, bagValue: '1000' })).toEqual({ rateUsed: '10.00', feeBags: '10.00', bagValue: '1000.00', feeAmount: '10000.00' });
  });

  test('harvest: the bag value can come from kilos per bag times the palay price', () => {
    const fee = computeServiceFee({ unit: 'per_100_bags', rate: '12', totalBags: '85', kgPerBag: '50', pricePerKg: '18.50' });
    expect(fee).toMatchObject({ feeBags: '10.20', bagValue: '925.00', feeAmount: '9435.00' });
  });

  test('edge case: fractional bags round half-up to the centavo', () => {
    // 33.25 bags x 10 / 100 = 3.325 bags, rounded half-up to 3.33 (not 3.32).
    expect(computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: '33.25', bagValue: '1000' })).toMatchObject({ feeBags: '3.33', feeAmount: '3330.00' });
    expect(computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: '33.33', bagValue: '999.99' })).toMatchObject({ feeBags: '3.33', feeAmount: '3329.97' });
  });
});
