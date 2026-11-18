import { describe, test, expect } from '@jest/globals';
import { salesReport } from '../../src/services/kadiwaGoods.js';

const sale = (saleDate, price, quantity, amount, money) => ({
  saleDate, goods: [{ name: 'PORK', unit: 'KILO', category: 'Meat', price, quantity, amount }],
  groceries: '0', vegetables: '0', meat: amount, ...money,
});
const first = sale('2026-09-01', '400.00', '2', '800.00', { totalExpenses: '100.00', costOfGoods: '500.00', netSales: '200.00' });
const second = sale('2026-09-02', '380.00', '1', '380.00', { totalExpenses: '50.00', costOfGoods: '250.00', netSales: '80.00' });

describe('Kadiwa 15-day and monthly sales report (salesReport)', () => {
  test('adds up each good over the period', () => {
    expect(salesReport([first, second]).lines).toEqual([{ name: 'PORK', unit: 'KILO', category: 'Meat', quantity: 3, price: '380.00', priceMax: '400.00', amount: '1180.00' }]);
  });

  test('totals the gross sales, expenses, cost of goods and net sales', () => {
    expect(salesReport([first, second]).totals).toEqual({ sales: 2, days: 2, gross: '1180.00', expenses: '150.00', costOfGoods: '750.00', net: '280.00' });
  });

  test('a good always sold at one price shows no highest price', () => {
    expect(salesReport([first]).lines[0]).toMatchObject({ price: '400.00', priceMax: null });
  });

  test('a period without sales gives an empty report', () => {
    expect(salesReport([])).toEqual({ lines: [], totals: { sales: 0, days: 0, gross: '0.00', expenses: '0.00', costOfGoods: '0.00', net: '0.00' } });
  });

  test('edge case: two sales on the same day count as one selling day', () => {
    expect(salesReport([first, { ...second, saleDate: '2026-09-01' }]).totals).toMatchObject({ sales: 2, days: 1 });
  });
});
