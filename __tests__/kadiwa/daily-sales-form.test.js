import { describe, test, expect } from '@jest/globals';
import { presentSaleLines, saleLines } from '../../src/services/kadiwaGoods.js';

const pork = { name: 'PORK', unit: 'KILO', category: 'Meat', price: '400.00', quantity: '2', amount: '800.00' };

describe('Daily sales form lines (saleLines, presentSaleLines)', () => {
  test('each good sold is a line with its quantity, price and amount', () => {
    expect(presentSaleLines({ goods: [pork], groceries: '0', vegetables: '0', meat: '800.00' }))
      .toEqual([{ name: 'PORK', unit: 'KILO', category: 'Meat', quantity: 2, price: '400.00', priceMax: null, amount: '800.00' }]);
  });

  test('store items sold from the inventory are added to GROCERIES', () => {
    const lines = saleLines({ goods: [], items: [{ category: 'Groceries', lineTotal: '120.00' }], groceries: '120.00', vegetables: '0', meat: '0' });
    expect(lines).toEqual([{ name: 'GROCERIES', unit: null, category: 'Groceries', priceCents: null, quantity: null, amountCents: 12000 }]);
  });

  test('category amounts not covered by a line become GROCERIES, VEGETABLES and MEAT', () => {
    const lines = presentSaleLines({ goods: [pork], items: [{ category: 'Groceries', lineTotal: '120.00' }], groceries: '500.00', vegetables: '300.00', meat: '800.00' });
    expect(lines.map(({ name, amount }) => [name, amount])).toEqual([['PORK', '800.00'], ['GROCERIES', '500.00'], ['VEGETABLES', '300.00']]);
  });

  test('a sale saved before goods were itemized shows its category totals', () => {
    expect(presentSaleLines({ groceries: '1000', vegetables: '0', meat: '250' }).map(({ name, amount }) => [name, amount])).toEqual([['GROCERIES', '1000.00'], ['MEAT', '250.00']]);
  });

  test('edge case: lines follow the paper form\'s order, other goods last', () => {
    const goods = [{ name: 'UBE', category: 'Vegetables', amount: '90' }, { name: 'KAMATIS', unit: 'KILO', category: 'Vegetables', amount: '80' }, { ...pork }];
    expect(presentSaleLines({ goods, groceries: '0', vegetables: '170', meat: '800' }).map((line) => line.name)).toEqual(['PORK', 'KAMATIS', 'UBE']);
  });
});
