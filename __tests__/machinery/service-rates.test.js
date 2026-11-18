import { describe, test, expect } from '@jest/globals';
import { FeeInputError, findRateForDate, rateForClient } from '../../src/services/machineryFees.js';

const rates = [
  { serviceType: 'Rotavator', unit: 'per_ha', memberRate: '2800.00', nonMemberRate: '2800.00', effectiveFrom: '2026-01-01', effectiveTo: '2026-04-30' },
  { serviceType: 'Rotavator', unit: 'per_ha', memberRate: '3800.00', nonMemberRate: '4000.00', effectiveFrom: '2026-05-01', effectiveTo: null },
  { serviceType: 'Squadrone', unit: 'per_ha', memberRate: '3400.00', nonMemberRate: '3400.00', effectiveFrom: '2026-05-01', effectiveTo: null },
];

describe('Machinery service rates (findRateForDate, rateForClient)', () => {
  test('uses the rate in effect on the service date', () => {
    expect(findRateForDate(rates, 'Rotavator', '2026-03-15').memberRate).toBe('2800.00');
    expect(findRateForDate(rates, 'Rotavator', '2026-06-10').memberRate).toBe('3800.00');
  });

  test('the first and last day of a rate period both count', () => {
    expect(findRateForDate(rates, 'Rotavator', '2026-04-30').memberRate).toBe('2800.00');
    expect(findRateForDate(rates, 'Rotavator', '2026-05-01').memberRate).toBe('3800.00');
  });

  test('the service name is matched without regard to case or spaces', () => {
    expect(findRateForDate(rates, '  squadrone ', '2026-06-11').memberRate).toBe('3400.00');
  });

  test('no rate before a service starts, or for an unknown service', () => {
    expect(findRateForDate(rates, 'Squadrone', '2026-04-30')).toBeNull();
    expect(findRateForDate(rates, 'Drone spraying', '2026-06-11')).toBeNull();
    expect(findRateForDate([], 'Rotavator', '2026-06-11')).toBeNull();
  });

  test('members and non-members pay their own rates', () => {
    const rate = findRateForDate(rates, 'Rotavator', '2026-06-10');
    expect(rateForClient(rate, 'member')).toBe('3800.00');
    expect(rateForClient(rate, 'non_member')).toBe('4000.00');
  });

  test('edge case: an unknown kind of client is refused', () => {
    expect(() => rateForClient(rates[1], 'guest')).toThrow(FeeInputError);
    expect(() => rateForClient(rates[1], 'guest')).toThrow('Client category must be member or non-member.');
  });
});
