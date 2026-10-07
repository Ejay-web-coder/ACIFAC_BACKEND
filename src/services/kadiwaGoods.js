import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { badRequest } from '../utils/http.js';

// The goods on the Kadiwa ng Pangulo daily sales form, in the form's order,
// with the unit and price written on it (September 2026). The sale form starts
// from this list; a good sold before comes back with the unit and price it was
// last sold at, and goods typed in once are added after these.
export const KADIWA_GOODS = [
  { name: 'PORK', unit: 'KILO', price: '400.00', category: 'Meat' },
  { name: 'EGG', unit: 'TRAY', price: '260.00', category: 'Groceries' },
  { name: 'GROCERIES', unit: null, price: null, category: 'Groceries' },
  { name: 'SIBUYAS/BAWANG', unit: 'KILO', price: '200.00', category: 'Vegetables' },
  { name: 'TALONG', unit: 'KILO', price: '100.00', category: 'Vegetables' },
  { name: 'TINAPA', unit: 'BALOT', price: '50.00', category: 'Groceries' },
  { name: 'FROZEN', unit: 'KILO', price: '30.00', category: 'Groceries' },
  { name: 'ITLOG MAALAT', unit: 'PC', price: '18.00', category: 'Groceries' },
  { name: 'SAGING', unit: 'KILO', price: '35.00', category: 'Vegetables' },
  { name: 'KALABASA', unit: 'BALOT', price: '15.00', category: 'Vegetables' },
  { name: 'REPOLYO', unit: 'KILO', price: '100.00', category: 'Vegetables' },
  { name: 'CHICKEN', unit: 'KILO', price: '220.00', category: 'Meat' },
  { name: 'SITAW', unit: 'BALOT', price: '15.00', category: 'Vegetables' },
  { name: 'SAYOTE', unit: 'KILO', price: '180.00', category: 'Vegetables' },
  { name: 'CARROTS', unit: 'KILO', price: '150.00', category: 'Vegetables' },
  { name: 'KAMIAS', unit: 'BALOT', price: '5.00', category: 'Vegetables' },
  { name: 'BIGAS', unit: 'KILO', price: '20.00', category: 'Groceries' },
  { name: 'LUYA', unit: 'KILO', price: '60.00', category: 'Vegetables' },
  { name: 'SILI', unit: 'BALOT', price: '10.00', category: 'Vegetables' },
  { name: 'OKRA', unit: 'PC', price: '2.00', category: 'Vegetables' },
  { name: 'TALBOS', unit: 'BALOT', price: '15.00', category: 'Vegetables' },
  { name: 'AMPALAYA', unit: 'KILO', price: '80.00', category: 'Vegetables' },
  { name: 'KALAMANSI', unit: 'KILO', price: '100.00', category: 'Vegetables' },
  { name: 'PATATAS', unit: 'KILO', price: '150.00', category: 'Vegetables' },
  { name: 'PATOLA', unit: 'KILO', price: '20.00', category: 'Vegetables' },
  { name: 'KAMOTE', unit: 'KILO', price: '30.00', category: 'Vegetables' },
  { name: 'PUSO SAGING', unit: 'PC', price: '20.00', category: 'Vegetables' },
  { name: 'BULAK2 KALABASA', unit: 'BALOT', price: '25.00', category: 'Vegetables' },
  { name: 'MONGGO', unit: 'BALOT', price: '20.00', category: 'Groceries' },
  { name: 'PAKBET', unit: 'BALOT', price: '25.00', category: 'Vegetables' },
  { name: 'KAMATIS', unit: 'KILO', price: '80.00', category: 'Vegetables' },
];
const ORDER = new Map(KADIWA_GOODS.map((good, index) => [good.name, index]));
const PRESET = new Map(KADIWA_GOODS.map((good) => [good.name, good]));

export const GOODS_CATEGORIES = ['Groceries', 'Vegetables', 'Meat', 'Other'];
const QUANTITY = /^\d+(\.\d{1,4})?$/;
const MAX_LINES = 100;

/** "  bulak2   kalabasa " -> "BULAK2 KALABASA"; units likewise, with PCS written PC. */
export const goodsName = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, 120);
export const goodsUnit = (value) => {
  const unit = String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, 20);
  return unit === 'PCS' ? 'PC' : unit || null;
};

// The form's goods with the unit, price and category each was last sold at.
export async function goodsForForm(db) {
  const used = (await db.query(
    `SELECT DISTINCT ON (g.name) g.name, g.unit, g.price, g.category
       FROM kadiwa_sale_goods g JOIN kadiwa_sales s ON s.id = g.sale_id
      WHERE s.status = 'completed'
      ORDER BY g.name, s.sale_date DESC, s.created_at DESC, g.id DESC`
  )).rows;
  const last = new Map(used.map((good) => [good.name, good]));
  const preset = KADIWA_GOODS.map((good) => ({ ...good, ...(last.get(good.name) || {}) }));
  const others = used.filter((good) => !PRESET.has(good.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...preset, ...others].map((good) => ({ name: good.name, unit: good.unit || null, category: good.category, price: good.price === null || good.price === undefined ? null : String(good.price) }));
}

// Checks the goods lines of a sale. Each line needs its total amount, or a
// quantity and price to work it out; when only the amount is written, the
// quantity is amount / price, as the 15-day report computes it.
export function parseGoodsLines(lines) {
  if (lines === undefined || lines === null) return [];
  if (!Array.isArray(lines)) throw badRequest('The goods sold must be a list.');
  if (lines.length > MAX_LINES) throw badRequest(`A sale can have at most ${MAX_LINES} goods.`);
  const seen = new Set();
  return lines.map((raw, index) => {
    const line = raw && typeof raw === 'object' ? raw : {};
    const name = goodsName(line.name);
    const label = name || `Line ${index + 1}`;
    if (!name) throw badRequest(`${label}: enter the goods sold.`);
    const unit = goodsUnit(line.unit);
    const category = GOODS_CATEGORIES.includes(line.category) ? line.category : PRESET.get(name)?.category || 'Other';
    const priceText = String(line.price ?? '').trim();
    const priceCents = priceText ? parseMoneyInput(priceText, { allowZero: true }) : null;
    if (priceText && priceCents === null) throw badRequest(`${label}: the price must be an amount like 400 or 12.50.`);
    const quantityText = String(line.quantity ?? '').trim();
    if (quantityText && (!QUANTITY.test(quantityText) || Number(quantityText) <= 0)) throw badRequest(`${label}: the quantity must be more than zero, with at most 4 decimals.`);
    const amountText = String(line.amount ?? '').trim();
    let amountCents = amountText ? parseMoneyInput(amountText) : null;
    if (amountText && amountCents === null) throw badRequest(`${label}: the total amount must be more than zero, with at most two decimals.`);
    if (amountCents === null) {
      if (!quantityText || !priceCents) throw badRequest(`${label}: enter the total amount, or the quantity and the price.`);
      amountCents = Math.round(Number(quantityText) * priceCents);
      if (amountCents <= 0) throw badRequest(`${label}: the total amount must be more than zero.`);
    }
    const worked = !quantityText && priceCents ? (amountCents / priceCents).toFixed(4) : null;
    const quantity = quantityText || (worked && Number(worked) > 0 ? worked : null);
    const key = `${name}|${unit || ''}`;
    if (seen.has(key)) throw badRequest(`${name}${unit ? ` (${unit})` : ''} is written twice. Put it on one line.`);
    seen.add(key);
    return { name, unit, category, price: priceCents === null ? null : centsToString(priceCents), quantity, amount: centsToString(amountCents) };
  });
}

const MAX_EXPENSES = 30;

// Checks the expenses of a sale, one line each: what it was for and the amount
// (zero allowed, for a day without expenses). null when the list was not sent.
export function parseExpenseLines(lines) {
  if (lines === undefined || lines === null) return null;
  if (!Array.isArray(lines)) throw badRequest('The expenses must be a list.');
  if (lines.length > MAX_EXPENSES) throw badRequest(`A sale can have at most ${MAX_EXPENSES} expenses.`);
  return lines.map((raw, index) => {
    const line = raw && typeof raw === 'object' ? raw : {};
    const description = String(line.description ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!description) throw badRequest(`Expense ${index + 1}: enter what it was for.`);
    const cents = parseMoneyInput(String(line.amount ?? '').trim(), { allowZero: true });
    if (cents === null) throw badRequest(`${description}: enter the amount, with at most two decimals (0 if none).`);
    return { description, amount: centsToString(cents), cents };
  });
}

const sumCents = (rows, pick) => rows.reduce((sum, row) => sum + toCents(pick(row)), 0);
const roundQuantity = (value) => Math.round(value * 10000) / 10000;

// The lines of one sale as the daily form shows them: each good sold; the store
// items sold from the inventory, added to GROCERIES; and for a sale saved
// before goods were itemized (or read from a scanned form), the category
// amounts not accounted for by a line, as GROCERIES, VEGETABLES and MEAT.
export function saleLines(sale) {
  const lines = (sale.goods || []).map((good) => ({
    name: good.name, unit: good.unit || null, category: good.category,
    priceCents: good.price === null || good.price === undefined ? null : toCents(good.price),
    quantity: good.quantity === null || good.quantity === undefined ? null : Number(good.quantity),
    amountCents: toCents(good.amount),
  }));
  const items = sale.items || [];
  const column = (category) => (category === 'Meat' ? 'meat' : category === 'Vegetables' ? 'vegetables' : 'groceries');
  const accounted = { groceries: 0, vegetables: 0, meat: 0 };
  for (const line of lines) accounted[column(line.category)] += line.amountCents;
  for (const item of items) accounted[column(item.category)] += toCents(item.lineTotal);
  const addTo = (name, category, cents) => {
    if (cents <= 0) return;
    const existing = lines.find((line) => line.name === name && !line.unit);
    if (existing) existing.amountCents += cents;
    else lines.push({ name, unit: null, category, priceCents: null, quantity: null, amountCents: cents });
  };
  addTo('GROCERIES', 'Groceries', sumCents(items, (item) => item.lineTotal));
  addTo('GROCERIES', 'Groceries', toCents(sale.groceries) - accounted.groceries);
  addTo('VEGETABLES', 'Vegetables', toCents(sale.vegetables) - accounted.vegetables);
  addTo('MEAT', 'Meat', toCents(sale.meat) - accounted.meat);
  return lines;
}

const lineOrder = (line) => (ORDER.has(line.name) ? ORDER.get(line.name) : KADIWA_GOODS.length);

const present = (line) => ({
  name: line.name, unit: line.unit, category: line.category,
  quantity: line.quantity === null ? null : roundQuantity(line.quantity),
  price: line.priceCents === null ? null : centsToString(line.priceCents),
  priceMax: line.priceMaxCents === undefined || line.priceMaxCents === line.priceCents ? null : centsToString(line.priceMaxCents),
  amount: centsToString(line.amountCents),
});
const sortLines = (lines) => lines.sort((a, b) => lineOrder(a) - lineOrder(b) || a.name.localeCompare(b.name) || String(a.unit || '').localeCompare(String(b.unit || '')));

/** One sale's lines, in the form's order, ready to send. */
export const presentSaleLines = (sale) => sortLines(saleLines(sale)).map(present);

// The 15-day or monthly report: every good sold in the period with its total
// quantity and amount, like the "September 1 to 15" summary. A good sold at more
// than one price shows the lowest and highest.
export function salesReport(sales) {
  const byGood = new Map();
  for (const sale of sales) {
    for (const line of saleLines(sale)) {
      const key = `${line.name}|${line.unit || ''}`;
      const total = byGood.get(key);
      if (!total) {
        byGood.set(key, { ...line, priceMaxCents: line.priceCents });
        continue;
      }
      total.amountCents += line.amountCents;
      if (line.quantity !== null) total.quantity = (total.quantity || 0) + line.quantity;
      if (line.priceCents !== null) {
        total.priceCents = total.priceCents === null ? line.priceCents : Math.min(total.priceCents, line.priceCents);
        total.priceMaxCents = total.priceMaxCents === null ? line.priceCents : Math.max(total.priceMaxCents, line.priceCents);
      }
    }
  }
  const lines = sortLines([...byGood.values()]).map(present);
  const grossCents = sales.reduce((sum, sale) => sum + toCents(sale.groceries) + toCents(sale.vegetables) + toCents(sale.meat), 0);
  return {
    lines,
    totals: {
      sales: sales.length,
      days: new Set(sales.map((sale) => sale.saleDate)).size,
      gross: centsToString(grossCents),
      expenses: centsToString(sumCents(sales, (sale) => sale.totalExpenses)),
      costOfGoods: centsToString(sumCents(sales, (sale) => sale.costOfGoods)),
      net: centsToString(sumCents(sales, (sale) => sale.netSales)),
    },
  };
}
