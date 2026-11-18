import { describe, test, expect } from '@jest/globals';
import { paymentSummary } from '../../src/services/machineryFees.js';

describe('Machinery service payment status (paymentSummary)', () => {
  test('fully paid: no balance left', () => {
    expect(paymentSummary('5700.00', '5700')).toEqual({ balance: '0.00', paymentStatus: 'full' });
  });

  test('partly paid: the rest is still due', () => {
    expect(paymentSummary('5700.00', '4000')).toEqual({ balance: '1700.00', paymentStatus: 'partial' });
  });

  test('nothing paid yet: the whole fee is due', () => {
    expect(paymentSummary('3400.00', '0')).toEqual({ balance: '3400.00', paymentStatus: 'unpaid' });
  });

  test('an invalid amount paid is refused', () => {
    expect(() => paymentSummary('3400.00', '')).toThrow('Amount paid must be a number that is zero or more.');
  });

  test('edge case: paying more than the fee shows a negative balance and counts as full', () => {
    expect(paymentSummary('3400.00', '3500')).toEqual({ balance: '-100.00', paymentStatus: 'full' });
  });
});
