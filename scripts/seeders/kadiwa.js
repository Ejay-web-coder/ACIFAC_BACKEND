import { insertKadiwaSale } from '../../src/controllers/kadiwaController.js';
import { parseExpenseLines, parseGoodsLines } from '../../src/services/kadiwaGoods.js';
import { addDays, stampSql } from './support.js';

// Kadiwa store: products for the inventory notebook (with cost prices, so net
// income can be worked out) and one daily sales form for each of the last ten
// days, saved through the same code as New Sale (stock goes down, low stock is
// flagged). Laundry Soap starts below its low-stock level on purpose.
const PRODUCTS = [
  { name: 'Dinorado Rice', unit: 'kg', stock: '150', price: '58.00', cost: '50.00', reorder: '30' },
  { name: 'Brown Sugar', size: ['1', 'kg'], unit: 'pack', stock: '40', price: '85.00', cost: '74.00', reorder: '10' },
  { name: 'Palm Oil', size: ['1', 'L'], unit: 'bottle', stock: '24', price: '110.00', cost: '96.00', reorder: '8' },
  { name: 'Soy Sauce', size: ['1', 'L'], unit: 'bottle', stock: '18', price: '65.00', cost: '55.00', reorder: '6' },
  { name: 'Cane Vinegar', size: ['1', 'L'], unit: 'bottle', stock: '18', price: '55.00', cost: '46.00', reorder: '6' },
  { name: 'Sardines in Tomato Sauce', size: ['155', 'g'], unit: 'can', stock: '60', price: '26.00', cost: '21.50', reorder: '15' },
  { name: 'Instant Noodles', size: ['55', 'g'], unit: 'pack', stock: '80', price: '12.00', cost: '9.50', reorder: '20' },
  { name: 'Coffee 3-in-1', size: ['20', 'g'], unit: 'sachet', stock: '120', price: '10.00', cost: '7.80', reorder: '30' },
  { name: 'Laundry Soap', unit: 'bar', stock: '9', price: '28.00', cost: '23.00', reorder: '10' },
];
// What each day's form sells from the store shelves: [product, quantity] (kept within the stock above).
const STORE_SALES = [
  [['Dinorado Rice', 12], ['Sardines in Tomato Sauce', 4], ['Coffee 3-in-1', 10]],
  [['Dinorado Rice', 8], ['Instant Noodles', 6], ['Brown Sugar', 2]],
  [['Dinorado Rice', 10], ['Palm Oil', 1], ['Soy Sauce', 1], ['Coffee 3-in-1', 8]],
  [['Dinorado Rice', 9], ['Sardines in Tomato Sauce', 5], ['Instant Noodles', 8]],
  [['Dinorado Rice', 11], ['Cane Vinegar', 2], ['Coffee 3-in-1', 12], ['Brown Sugar', 1]],
];
// Goods brought in for the day (vegetables, meat, eggs), priced per the daily form: [name, quantity].
const GOODS_SALES = [
  [['PORK', 4], ['EGG', 3], ['TALONG', 3], ['KAMATIS', 2]],
  [['CHICKEN', 5], ['SIBUYAS/BAWANG', 2], ['AMPALAYA', 2], ['SAGING', 4]],
  [['PORK', 3], ['EGG', 2], ['REPOLYO', 2], ['SITAW', 6], ['KALAMANSI', 1]],
  [['CHICKEN', 4], ['TALONG', 2], ['KAMATIS', 3], ['PATATAS', 1]],
  [['PORK', 5], ['EGG', 4], ['CARROTS', 1.5], ['SAYOTE', 1], ['LUYA', 0.5]],
];
const PRICES = { PORK: '400', EGG: '260', TALONG: '100', KAMATIS: '80', CHICKEN: '220', 'SIBUYAS/BAWANG': '200', AMPALAYA: '80', SAGING: '35', REPOLYO: '100', SITAW: '15', KALAMANSI: '100', PATATAS: '150', CARROTS: '150', SAYOTE: '180', LUYA: '60' };
const UNITS = { EGG: 'TRAY', SITAW: 'BALOT' };
const SELLERS = ['Lourdes Fernandez', 'Gloria Ramirez'];

export default async function seedKadiwa(ctx) {
  const { client, req, today } = ctx;
  // All products in one statement, numbered INV-#### like the inventory sheet.
  const column = (pick) => PRODUCTS.map(pick);
  const added = (await client.query(
    `INSERT INTO kadiwa_inventory (id, name, category, size_value, size_unit, unit, stock, price, cost_price, reorder_level)
     SELECT 'INV-' || LPAD(nextval('kadiwa_inventory_seq')::text, 4, '0'), r.name, 'Groceries', r.size_value, r.size_unit, r.unit, r.stock, r.price, r.cost, r.reorder
     FROM unnest($1::text[], $2::numeric[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[]) WITH ORDINALITY
          AS r(name, size_value, size_unit, unit, stock, price, cost, reorder, ord)
     ORDER BY r.ord
     RETURNING id, name`,
    [column((p) => p.name), column((p) => p.size?.[0] ?? null), column((p) => p.size?.[1] ?? null), column((p) => p.unit), column((p) => p.stock),
      column((p) => p.price), column((p) => p.cost), column((p) => p.reorder)]
  )).rows;
  const ids = new Map(added.map((row) => [row.name, row.id]));
  ctx.count('Kadiwa products', added.length);

  for (let daysAgo = 9; daysAgo >= 0; daysAgo -= 1) {
    const saleDate = addDays(today, -daysAgo);
    const goods = parseGoodsLines(GOODS_SALES[daysAgo % GOODS_SALES.length].map(([name, quantity]) => ({ name, unit: UNITS[name] || 'KILO', price: PRICES[name], quantity: String(quantity) })));
    const expenseLines = parseExpenseLines([
      { description: 'Transportation from the bagsakan', amount: daysAgo % 2 ? '200' : '150' },
      { description: 'Plastic bags', amount: '45' },
      ...(goods.some((good) => good.category === 'Meat') ? [{ description: 'Ice for the meat', amount: '60' }] : []),
    ]);
    const saleId = await insertKadiwaSale(client, req, {
      encoderName: SELLERS[daysAgo % SELLERS.length], saleDate, manual: {},
      expensesCents: expenseLines.reduce((sum, line) => sum + line.cents, 0),
      items: STORE_SALES[daysAgo % STORE_SALES.length].map(([name, quantity]) => ({ inventoryId: ids.get(name), quantity: String(quantity) })),
      goods, expenseLines,
    });
    if (daysAgo > 0) await client.query(`UPDATE kadiwa_sales SET created_at = ${stampSql('$2', '17:30')} WHERE id = $1`, [saleId, saleDate]);
    ctx.count('Kadiwa sales');
  }
}
