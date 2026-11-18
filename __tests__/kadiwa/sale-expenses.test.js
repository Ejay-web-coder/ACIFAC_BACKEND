import { describe, test, expect } from '@jest/globals';
import { parseExpenseLines } from '../../src/services/kadiwaGoods.js';

describe('Expenses of a Kadiwa sale (parseExpenseLines)', () => {
  test('reads each expense with its amount in centavos', () => {
    expect(parseExpenseLines([{ description: ' Jeep   fare ', amount: '150' }])).toEqual([{ description: 'Jeep fare', amount: '150.00', cents: 15000 }]);
  });

  test('a zero expense is allowed for a day without expenses', () => {
    expect(parseExpenseLines([{ description: 'None', amount: '0' }])[0].cents).toBe(0);
  });

  test('rejects an expense without a description or with a bad amount', () => {
    expect(() => parseExpenseLines([{ description: '', amount: '50' }])).toThrow('Expense 1: enter what it was for.');
    expect(() => parseExpenseLines([{ description: 'Plastic bags', amount: '-5' }])).toThrow('Plastic bags: enter the amount, with at most two decimals (0 if none).');
    expect(() => parseExpenseLines([{ description: 'Plastic bags', amount: '' }])).toThrow('Plastic bags: enter the amount, with at most two decimals (0 if none).');
  });

  test('no list sent means the expenses are left unchanged', () => {
    expect(parseExpenseLines(undefined)).toBeNull();
    expect(parseExpenseLines(null)).toBeNull();
  });

  test('edge case: a non-list or more than 30 expenses is refused', () => {
    expect(() => parseExpenseLines({ description: 'fare' })).toThrow('The expenses must be a list.');
    expect(() => parseExpenseLines(Array.from({ length: 31 }, () => ({ description: 'fare', amount: '1' })))).toThrow('A sale can have at most 30 expenses.');
  });
});
