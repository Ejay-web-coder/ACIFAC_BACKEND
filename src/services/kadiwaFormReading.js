import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { centsToString, parseMoneyInput } from '../utils/money.js';
import { GOODS_CATEGORIES, goodsName, goodsUnit } from './kadiwaGoods.js';

// The printed Kadiwa forms (Add Inventory and Daily Sales, downloaded from the
// Kadiwa Store page) as read by the OCR Scanner: the lines are normalised into
// what Add Inventory and New Sale save, and the checks point out what does not
// add up on the paper (a line total that is not quantity x price, a grand
// total that is not the sum of the lines). Saving still goes through the
// Kadiwa Store's own rules.

const SIZE_UNITS = { ml: 'mL', l: 'L', mg: 'mg', g: 'g', kg: 'kg' };
const COUNT_UNITS = { pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', pack: 'pack', packs: 'pack', bottle: 'bottle', bottles: 'bottle', btl: 'bottle', can: 'can', cans: 'can',
  sachet: 'sachet', sachets: 'sachet', box: 'box', boxes: 'box', kg: 'kg', kilo: 'kg' };
const CATEGORIES = ['Groceries', 'Vegetables', 'Meat', 'Other'];
const MAX_ROWS = 200;
// Differences up to one peso are handwriting rounding, not mistakes.
const TOLERANCE_CENTS = 100;

// ---------------------------------------------------------------------------

const text = (value, max = 200) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().replace(/\s+/g, ' ').slice(0, max) : '');
const list = (value, max) => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object').slice(0, max) : []);
const compact = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

/** "₱1,250.00" -> "1250.00"; "" when it is not an amount. */
function number(value, decimals = 2) {
  const cleaned = text(value, 40).replace(/₱|php|,|\s/gi, '').replace(/^p(?=\d)/i, '');
  return new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(cleaned) ? String(Number(cleaned)) : '';
}

function date(value) {
  const written = text(value, 40);
  if (!written) return '';
  if (isValidDateOnly(written)) return written;
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(written);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    const candidate = `${year}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
    return isValidDateOnly(candidate) ? candidate : '';
  }
  const parsed = Date.parse(`${written} 12:00 UTC`);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 10);
}

const cents = (value) => (value ? parseMoneyInput(value, { allowZero: true }) : null);
const peso = (amountCents) => `PHP ${(amountCents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const times = (quantity, priceCents) => Math.round(Number(quantity) * priceCents);

function confidenceOf(raw) {
  const value = Number.parseFloat(String(raw?.confidence ?? '').replace('%', ''));
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

const aiIssues = (raw) => (Array.isArray(raw?.issues) ? raw.issues : []).map((issue) => text(issue, 300)).filter(Boolean).slice(0, 12);

/** A product's size written apart ("150", "g") or together ("150g"). */
function size(valueText, unitText) {
  let value = text(valueText, 20);
  let unit = text(unitText, 10);
  const together = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(value);
  if (together) [, value, unit] = together;
  const sizeValue = number(value, 3);
  return { sizeValue, sizeUnit: sizeValue ? SIZE_UNITS[unit.toLowerCase()] || '' : '' };
}

function quantityWithUnit(quantityText, unitText) {
  let quantity = text(quantityText, 20);
  let unit = text(unitText, 20);
  const together = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(quantity);
  if (together) [, quantity, unit] = together;
  return { stock: number(quantity), unit: COUNT_UNITS[unit.toLowerCase()] || '' };
}

// The AI's reading of an Add Inventory form, as rows of the Add Inventory sheet.
export function readInventoryForm(raw, existing = []) {
  const warnings = [];
  const category = CATEGORIES.find((option) => option.toLowerCase() === text(raw?.category, 20).toLowerCase()) || '';
  const rows = list(raw?.rows, MAX_ROWS).map((row, index) => {
    const line = Number.isInteger(Number(row.line)) && Number(row.line) > 0 ? Number(row.line) : index + 1;
    const { sizeValue, sizeUnit } = size(row.sizeValue, row.sizeUnit);
    const { stock, unit } = quantityWithUnit(row.quantity, row.unit);
    return {
      line, name: text(row.product, 200), sizeValue, sizeUnit, unit, stock,
      price: number(row.sellingPrice), costPrice: number(row.costPrice), total: number(row.total),
    };
  }).filter((row) => row.name || row.stock || row.price || row.costPrice);

  const known = new Set(existing.map((item) => compact(`${item.name}|${item.sizeValue === null ? '' : Number(item.sizeValue)}|${item.sizeUnit ?? ''}`)));
  let sumCents = 0;
  for (const row of rows) {
    const label = `Line ${row.line}${row.name ? ` (${row.name})` : ''}`;
    const missing = [!row.name && 'the product', !row.stock && 'the quantity', !row.price && 'the selling price', !row.costPrice && 'the cost price'].filter(Boolean);
    if (missing.length) warnings.push(`${label}: ${missing.join(', ')} could not be read. Type ${missing.length > 1 ? 'them' : 'it'} in from the paper.`);
    const cost = cents(row.costPrice);
    if (row.stock && cost !== null) {
      const computed = times(row.stock, cost);
      sumCents += computed;
      const written = cents(row.total);
      if (written !== null && Math.abs(written - computed) > TOLERANCE_CENTS) {
        warnings.push(`${label}: ${row.stock} × ${peso(cost)} = ${peso(computed)}, but the form says ${peso(written)}.`);
      }
    }
    if (cost !== null && cents(row.price) !== null && cents(row.price) < cost) warnings.push(`${label}: the selling price is lower than the cost price.`);
    if (row.name && known.has(compact(`${row.name}|${row.sizeValue ? Number(row.sizeValue) : ''}|${row.sizeUnit}`))) {
      warnings.push(`${label}: already in the inventory. Use Restock on that product instead, or remove this line.`);
    }
  }
  const grand = cents(number(raw?.grandTotal));
  if (grand !== null && rows.length && Math.abs(grand - sumCents) > TOLERANCE_CENTS) warnings.push(`The lines add up to ${peso(sumCents)} (quantity × cost price), but the TOTAL on the form says ${peso(grand)}.`);
  if (!rows.length) warnings.push('No product lines were read from the form.');

  return {
    kind: 'inventory', formCode: text(raw?.formCode, 40), confidence: confidenceOf(raw), date: date(raw?.date), preparedBy: text(raw?.preparedBy),
    category, lowStockAt: number(raw?.lowStockAt), rows, warnings, issues: aiIssues(raw),
  };
}

// The AI's reading of a Daily Sales form, as the New Sale sheet: goods (matched
// to the form's list), store items (matched to the inventory) and expenses.
// products: { id, label, name, price, stock, costPrice } of the inventory.
export function readSalesForm(raw, goods, products) {
  const warnings = [];
  const goodsByName = new Map(goods.map((good) => [compact(good.name), good]));
  const byId = new Map(products.map((product) => [product.id.toUpperCase(), product]));
  const byLabel = new Map(products.map((product) => [compact(product.label), product]));

  const readGoods = [];
  for (const line of list(raw?.goods, 100)) {
    const name = goodsName(line.name);
    const quantity = number(line.quantity, 4);
    const amount = number(line.amount);
    if (!name || (!quantity && !amount) || (Number(quantity || 0) === 0 && Number(amount || 0) === 0)) continue;
    const known = goodsByName.get(compact(name));
    const price = number(line.price) || (known?.price ? String(Number(known.price)) : '');
    const good = { name: known?.name || name, unit: goodsUnit(line.unit) || known?.unit || '', category: known?.category || (GOODS_CATEGORIES.includes(line.category) ? line.category : 'Other'),
      price, quantity, amount, listed: Boolean(known) };
    const priceCents = cents(price);
    if (quantity && amount && priceCents) {
      const computed = times(quantity, priceCents);
      if (Math.abs(computed - cents(amount)) > TOLERANCE_CENTS) warnings.push(`${good.name}: ${quantity} × ${peso(priceCents)} = ${peso(computed)}, but the form says ${peso(cents(amount))}.`);
    }
    if (!amount && !priceCents) warnings.push(`${good.name}: the quantity was read but there is no price or total amount. Type the total amount.`);
    if (!known) warnings.push(`${good.name} is not on the printed list; it was added as other goods (${good.category}). Check its category.`);
    readGoods.push(good);
  }

  const items = [];
  // Store items written on the paper that are not in the inventory: the sale cannot be saved with them.
  const unmatched = [];
  for (const line of list(raw?.storeItems, 100)) {
    const quantity = number(line.quantity);
    if (!quantity || Number(quantity) === 0) continue;
    const product = byId.get(text(line.inventoryId, 30).toUpperCase()) || byLabel.get(compact(text(line.product)));
    if (!product) { unmatched.push(text(line.product) || text(line.inventoryId)); warnings.push(`Store item "${text(line.product) || text(line.inventoryId)}" (${quantity}) is not in the inventory. Add it with Add Inventory, or sell it as other goods.`); continue; }
    const amount = cents(number(line.amount));
    const computed = times(quantity, Math.round(Number(product.price) * 100));
    if (amount !== null && Math.abs(amount - computed) > TOLERANCE_CENTS) warnings.push(`${product.label}: ${quantity} × ${peso(Math.round(Number(product.price) * 100))} = ${peso(computed)}, but the form says ${peso(amount)}.`);
    if (Number(quantity) > Number(product.stock)) warnings.push(`${product.label}: the form sold ${quantity}, but only ${Number(product.stock)} are in stock.`);
    const existing = items.find((item) => item.inventoryId === product.id);
    if (existing) existing.quantity = String(Number(existing.quantity) + Number(quantity));
    else items.push({ inventoryId: product.id, label: product.label, quantity });
  }

  const expenses = list(raw?.expenses, 30).map((line) => ({ description: text(line.description, 120), amount: number(line.amount) }))
    .filter((line) => line.description || line.amount);
  for (const [index, line] of expenses.entries()) {
    if (!line.description || !line.amount) warnings.push(`Expense ${index + 1}: ${!line.description ? 'what it was for' : 'the amount'} could not be read.`);
  }

  // The totals written on the paper against the lines read.
  const goodsCents = readGoods.reduce((sum, good) => sum + (cents(good.amount) ?? (good.quantity && cents(good.price) ? times(good.quantity, cents(good.price)) : 0)), 0)
    + items.reduce((sum, item) => sum + times(item.quantity, Math.round(Number(byId.get(item.inventoryId).price) * 100)), 0);
  const expenseCents = expenses.reduce((sum, line) => sum + (cents(line.amount) ?? 0), 0);
  const written = { goodsSold: number(raw?.totals?.goodsSold), expenses: number(raw?.totals?.expenses), netIncome: number(raw?.totals?.netIncome) };
  if (written.goodsSold && Math.abs(cents(written.goodsSold) - goodsCents) > TOLERANCE_CENTS) warnings.push(`The goods and store items read add up to ${peso(goodsCents)}, but the TOTAL GOODS SOLD on the form says ${peso(cents(written.goodsSold))}.`);
  if (written.expenses && Math.abs(cents(written.expenses) - expenseCents) > TOLERANCE_CENTS) warnings.push(`The expenses read add up to ${peso(expenseCents)}, but the TOTAL EXPENSES on the form says ${peso(cents(written.expenses))}.`);
  if (written.goodsSold && written.netIncome && written.expenses && Math.abs(cents(written.goodsSold) - cents(written.expenses) - cents(written.netIncome)) > TOLERANCE_CENTS) {
    warnings.push(`On the form, goods sold ${peso(cents(written.goodsSold))} − expenses ${peso(cents(written.expenses))} is not the net income written (${peso(cents(written.netIncome))}). The net income is worked out again when the sale is saved.`);
  }
  if (!readGoods.length && !items.length) warnings.push('No goods or store items sold were read from the form.');

  let saleDate = date(raw?.saleDate);
  if (saleDate && saleDate > todayDateOnly()) { warnings.push(`The date read (${saleDate}) is in the future; check the date.`); saleDate = ''; }
  if (!saleDate) warnings.push('The date of the sales could not be read; enter it.');

  return {
    kind: 'sales', formCode: text(raw?.formCode, 40), confidence: confidenceOf(raw), saleDate, preparedBy: text(raw?.preparedBy),
    goods: readGoods, items, unmatched, expenses, writtenTotals: written, totals: { goodsSold: centsToString(goodsCents), expenses: centsToString(expenseCents) }, warnings, issues: aiIssues(raw),
  };
}
