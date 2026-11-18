import { describe, test, expect } from '@jest/globals';
import { parseGoodsLines } from '../../src/services/kadiwaGoods.js';

describe('Goods sold in a Kadiwa sale (parseGoodsLines)', () => {
  test('a line with quantity and price gets its total amount', () => {
    expect(parseGoodsLines([{ name: ' pork ', unit: 'kilo', price: '400', quantity: '2.5' }]))
      .toEqual([{ name: 'PORK', unit: 'KILO', category: 'Meat', price: '400.00', quantity: '2.5', amount: '1000.00' }]);
  });

  test('a line with only the amount and price gets its quantity worked out', () => {
    expect(parseGoodsLines([{ name: 'TALONG', unit: 'KILO', price: '100', amount: '250' }])[0]).toMatchObject({ quantity: '2.5000', amount: '250.00', category: 'Vegetables' });
  });

  test('rejects a bad price, a bad quantity, or a line with nothing to total', () => {
    expect(() => parseGoodsLines([{ name: 'PORK', price: 'abc', quantity: '1' }])).toThrow('PORK: the price must be an amount like 400 or 12.50.');
    expect(() => parseGoodsLines([{ name: 'PORK', price: '400', quantity: '-1' }])).toThrow('PORK: the quantity must be more than zero, with at most 4 decimals.');
    expect(() => parseGoodsLines([{ name: 'PORK', unit: 'KILO' }])).toThrow('PORK: enter the total amount, or the quantity and the price.');
  });

  test('a line without the name of the goods is refused', () => {
    expect(() => parseGoodsLines([{ name: '', amount: '100' }])).toThrow('Line 1: enter the goods sold.');
  });

  test('the same good and unit cannot be written on two lines', () => {
    expect(() => parseGoodsLines([{ name: 'PORK', unit: 'KILO', amount: '400' }, { name: 'pork', unit: 'kilo', amount: '800' }]))
      .toThrow('PORK (KILO) is written twice. Put it on one line.');
  });

  test('goods not on the paper form are filed under "Other" unless a category is chosen', () => {
    const [ube, honey] = parseGoodsLines([{ name: 'UBE', amount: '90' }, { name: 'HONEY', amount: '150', category: 'Groceries' }]);
    expect(ube.category).toBe('Other');
    expect(honey.category).toBe('Groceries');
  });

  test('edge case: no list means no goods; a non-list or more than 100 lines is refused', () => {
    expect(parseGoodsLines(undefined)).toEqual([]);
    expect(() => parseGoodsLines('PORK')).toThrow('The goods sold must be a list.');
    expect(() => parseGoodsLines(Array.from({ length: 101 }, (_, index) => ({ name: `GOOD ${index}`, amount: '1' })))).toThrow('A sale can have at most 100 goods.');
  });
});
