import { jest, describe, test, expect } from '@jest/globals';
import { goodsForForm, goodsName, goodsUnit, KADIWA_GOODS } from '../../src/services/kadiwaGoods.js';

// The goods last sold at the store, as the database returns them.
const soldBefore = (rows) => ({ query: jest.fn(async () => ({ rows })) });

describe('Kadiwa goods list (goodsName, goodsUnit, goodsForForm)', () => {
  test('goods and units are written in capitals with single spaces', () => {
    expect(goodsName('  bulak2   kalabasa ')).toBe('BULAK2 KALABASA');
    expect(goodsUnit(' kilo ')).toBe('KILO');
  });

  test('"PCS" is written as "PC"', () => {
    expect(goodsUnit('pcs')).toBe('PC');
  });

  test('a blank name or unit stays blank', () => {
    expect(goodsName(undefined)).toBe('');
    expect(goodsUnit('   ')).toBeNull();
  });

  test('the sale form lists the paper form\'s goods in order, at the price each was last sold', async () => {
    const goods = await goodsForForm(soldBefore([{ name: 'PORK', unit: 'KILO', price: '420.00', category: 'Meat' }]));
    expect(goods).toHaveLength(KADIWA_GOODS.length);
    expect(goods[0]).toEqual({ name: 'PORK', unit: 'KILO', category: 'Meat', price: '420.00' });
    expect(goods[1]).toEqual({ name: 'EGG', unit: 'TRAY', category: 'Groceries', price: '260.00' });
  });

  test('goods typed in before are added after the paper form\'s goods', async () => {
    const goods = await goodsForForm(soldBefore([{ name: 'UBE', unit: 'KILO', price: '90.00', category: 'Vegetables' }]));
    expect(goods.at(-1)).toEqual({ name: 'UBE', unit: 'KILO', category: 'Vegetables', price: '90.00' });
  });

  test('edge case: a good with no fixed price (GROCERIES) keeps no price', async () => {
    const goods = await goodsForForm(soldBefore([]));
    expect(goods.find((good) => good.name === 'GROCERIES')).toEqual({ name: 'GROCERIES', unit: null, category: 'Groceries', price: null });
  });
});
