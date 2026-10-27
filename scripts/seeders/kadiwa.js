import { insertKadiwaSale } from '../../src/controllers/kadiwaController.js';
import { parseExpenseLines, parseGoodsLines } from '../../src/services/kadiwaGoods.js';
import { centsToString, toCents } from '../../src/utils/money.js';
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

// Before those ten days: the daily goods (vegetables, meat, eggs) of a year of
// store days, six days a week with a day off now and then, busier in the
// harvest months, with the day's expenses. Written for all days at once, as
// the Daily Sales form records goods: no store items, so the stock is not touched.
const HISTORY_DAYS = 365;
const BUSY_MONTHS = new Set([4, 5, 11, 12]);

async function seedSalesHistory(ctx) {
  const { client, today } = ctx;
  const sales = [];
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 10; daysAgo -= 1) {
    const saleDate = addDays(today, -daysAgo);
    const weekday = new Date(`${saleDate}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || daysAgo % 11 === 4) continue;
    const busy = BUSY_MONTHS.has(Number(saleDate.slice(5, 7))) ? 1.4 : 1;
    const day = GOODS_SALES[daysAgo % GOODS_SALES.length];
    const goods = parseGoodsLines(day.map(([name, quantity], n) => ({
      name, unit: UNITS[name] || 'KILO', price: PRICES[name],
      quantity: String(Math.max(0.5, Math.round(quantity * busy * (0.7 + ((daysAgo * 7 + n * 3) % 7) / 10) * 2) / 2)),
    })));
    const expenseLines = parseExpenseLines([
      { description: 'Transportation from the bagsakan', amount: daysAgo % 2 ? '200' : '150' },
      { description: 'Plastic bags', amount: '45' },
      ...(goods.some((good) => good.category === 'Meat') ? [{ description: 'Ice for the meat', amount: '60' }] : []),
    ]);
    const totals = { Groceries: 0, Vegetables: 0, Meat: 0 };
    for (const good of goods) totals[good.category === 'Other' ? 'Groceries' : good.category] += toCents(good.amount);
    const expensesCents = expenseLines.reduce((sum, line) => sum + line.cents, 0);
    sales.push({ saleDate, seller: SELLERS[daysAgo % SELLERS.length], totals, expensesCents, goods, expenseLines,
      net: totals.Groceries + totals.Vegetables + totals.Meat - expensesCents });
  }
  if (!sales.length) return;

  const column = (pick) => sales.map(pick);
  const ids = new Map((await client.query(
    `INSERT INTO kadiwa_sales (id, sale_date, encoder_name, groceries, vegetables, meat, total_expenses, cost_of_goods, net_sales, created_by, created_at)
     SELECT 'S-' || TO_CHAR(r.day, 'YYYY') || '-' || LPAD(nextval('kadiwa_sale_seq')::text, 5, '0'), r.day, r.seller, r.groceries, r.vegetables, r.meat,
            r.expenses, 0, r.net, $8, ${stampSql('r.day', '17:30')}
     FROM unnest($1::date[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[]) AS r(day, seller, groceries, vegetables, meat, expenses, net)
     RETURNING id, sale_date::text AS day`,
    [column((s) => s.saleDate), column((s) => s.seller), column((s) => centsToString(s.totals.Groceries)), column((s) => centsToString(s.totals.Vegetables)),
      column((s) => centsToString(s.totals.Meat)), column((s) => centsToString(s.expensesCents)), column((s) => centsToString(s.net)), ctx.admin.id]
  )).rows.map((row) => [row.day, row.id]));

  const goods = sales.flatMap((sale) => sale.goods.map((good, index) => ({ saleId: ids.get(sale.saleDate), line: index + 1, ...good })));
  await client.query(
    `INSERT INTO kadiwa_sale_goods (sale_id, line_no, name, unit, category, price, quantity, amount)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[])`,
    [goods.map((g) => g.saleId), goods.map((g) => g.line), goods.map((g) => g.name), goods.map((g) => g.unit), goods.map((g) => g.category),
      goods.map((g) => g.price), goods.map((g) => g.quantity), goods.map((g) => g.amount)]
  );
  const expenses = sales.flatMap((sale) => sale.expenseLines.map((line, index) => ({ saleId: ids.get(sale.saleDate), line: index + 1, ...line })));
  await client.query(
    `INSERT INTO kadiwa_sale_expenses (sale_id, line_no, description, amount)
     SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[])`,
    [expenses.map((e) => e.saleId), expenses.map((e) => e.line), expenses.map((e) => e.description), expenses.map((e) => e.amount)]
  );
  ctx.count('Kadiwa sales', sales.length);

  // Members who bought on those days, with their name or member ID written on
  // the sale (patronage points): two to four a day, a part of the day's sales.
  const buyers = ctx.members.filter((member, index) => index % 3 !== 2);
  const purchases = sales.flatMap((sale, n) => {
    const gross = sale.totals.Groceries + sale.totals.Vegetables + sale.totals.Meat;
    const count = 2 + (n % 3);
    const picked = [...new Set(Array.from({ length: count }, (_, k) => buyers[(n * 7 + k * 13) % buyers.length]))];
    return picked.map((member, k) => ({
      saleId: ids.get(sale.saleDate), line: k + 1, member,
      cents: Math.max(5000, Math.floor((gross * [0.06, 0.1, 0.04, 0.08][(n + k) % 4]) / 100) * 100),
    })).filter((purchase, k, list) => list.slice(0, k + 1).reduce((sum, p) => sum + p.cents, 0) <= gross);
  });
  if (purchases.length) {
    await client.query(
      `INSERT INTO kadiwa_sale_members (sale_id, line_no, member_id, member_number, member_name, amount)
       SELECT * FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::text[], $6::numeric[])`,
      [purchases.map((p) => p.saleId), purchases.map((p) => p.line), purchases.map((p) => p.member.id), purchases.map((p) => p.member.memberNumber),
        purchases.map((p) => p.member.fullName), purchases.map((p) => centsToString(p.cents))]
    );
    ctx.count('Kadiwa member purchases', purchases.length);
  }
}

export default async function seedKadiwa(ctx) {
  await seedSalesHistory(ctx);
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
