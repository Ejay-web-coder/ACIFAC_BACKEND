import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, paginationMeta, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { notifyAdmins } from '../services/notificationService.js';
import { goodsForForm, parseExpenseLines, parseGoodsLines, presentSaleLines, salesReport } from '../services/kadiwaGoods.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';

const CATEGORIES = ['Groceries', 'Vegetables', 'Meat', 'Other'];
const CATEGORY_COLUMN = { Groceries: 'groceries', Vegetables: 'vegetables', Meat: 'meat', Other: null };
const QUANTITY_PATTERN = /^\d+(\.\d{1,2})?$/;
// A product's content size, as on the inventory notebook: Century Tuna 150 g, Toyo 200 mL.
const SIZE_PATTERN = /^\d+(\.\d{1,3})?$/;
const SIZE_UNITS = { ml: 'mL', l: 'L', mg: 'mg', g: 'g', kg: 'kg' };
const MAX_SHEET_ROWS = 200;
const INVENTORY_LOCK = 'acifac-kadiwa-inventory';

const inventorySelect = `
  SELECT id, name, category, size_value AS "sizeValue", size_unit AS "sizeUnit", stock, unit, price, cost_price AS "costPrice",
         reorder_level AS "reorderLevel", updated_at AS "updatedAt"
  FROM kadiwa_inventory`;
const inventoryOrder = 'LOWER(name), size_unit NULLS FIRST, size_value NULLS FIRST, id';

// "Century Tuna 150 g": the product name with its size, when it has one.
function productLabel(name, sizeValue, sizeUnit) {
  return sizeValue === null || sizeValue === undefined || !sizeUnit ? name : `${name} ${Number(sizeValue)} ${sizeUnit}`;
}

const salesSelect = `
  SELECT s.id, TO_CHAR(s.sale_date, 'YYYY-MM-DD') AS "saleDate", s.created_at AS date, s.encoder_name AS seller,
         s.groceries, s.vegetables, s.meat,
         s.total_expenses AS "totalExpenses", s.cost_of_goods AS "costOfGoods", s.net_sales AS "netSales", s.payment_method AS "paymentMethod", s.status,
         COALESCE((SELECT json_agg(json_build_object('name', g.name, 'unit', g.unit, 'category', g.category, 'price', g.price,
                   'quantity', g.quantity, 'amount', g.amount) ORDER BY g.line_no)
                   FROM kadiwa_sale_goods g WHERE g.sale_id = s.id), '[]'::json) AS goods,
         COALESCE((SELECT json_agg(json_build_object('inventoryId', i.inventory_id, 'name', i.item_name, 'category', i.category, 'quantity', i.quantity,
                   'unit', i.unit, 'unitPrice', i.unit_price, 'lineTotal', i.line_total, 'unitCost', i.unit_cost, 'lineCost', i.line_cost) ORDER BY i.id)
                   FROM kadiwa_sale_items i WHERE i.sale_id = s.id), '[]'::json) AS items,
         COALESCE((SELECT json_agg(json_build_object('description', e.description, 'amount', e.amount) ORDER BY e.line_no)
                   FROM kadiwa_sale_expenses e WHERE e.sale_id = s.id), '[]'::json) AS expenses
  FROM kadiwa_sales s`;
const salesOrder = 's.sale_date DESC, s.created_at DESC, s.id DESC';
const TODAY = `sale_date = ${SQL_TODAY} AND status = 'completed'`;
// Each sale with its lines as the daily form shows them (goods, GROCERIES with the store items).
const withLines = (sale) => ({ ...sale, lines: presentSaleLines(sale) });

export async function listKadiwaData(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const [inventory, sales, count, summary, goods] = await Promise.all([
    query(`${inventorySelect} WHERE deleted_at IS NULL ORDER BY ${inventoryOrder}`),
    query(`${salesSelect} ORDER BY ${salesOrder} LIMIT $1 OFFSET $2`, [limit, offset]),
    query('SELECT COUNT(*)::int AS total FROM kadiwa_sales'),
    query(
      // Today: the goods sold (revenue), their cost and the expenses, and what is left (net income).
      `SELECT COUNT(*) FILTER (WHERE ${TODAY})::int AS "todaySales",
              COALESCE(SUM(groceries + vegetables + meat) FILTER (WHERE ${TODAY}), 0) AS "todayRevenue",
              COALESCE(SUM(cost_of_goods) FILTER (WHERE ${TODAY}), 0) AS "todayCost",
              COALESCE(SUM(total_expenses) FILTER (WHERE ${TODAY}), 0) AS "todayExpenses",
              COALESCE(SUM(net_sales) FILTER (WHERE ${TODAY}), 0) AS "todayNetIncome",
              COALESCE(SUM(net_sales) FILTER (WHERE status = 'completed'), 0) AS "totalNetSales",
              (SELECT COUNT(*)::int FROM kadiwa_inventory WHERE cost_price IS NULL AND deleted_at IS NULL) AS "missingCostItems",
              -- Stock at cost price, as the notebook totals it; selling price where no cost is set.
              (SELECT COALESCE(SUM(ROUND(stock * COALESCE(cost_price, price), 2)), 0) FROM kadiwa_inventory WHERE deleted_at IS NULL) AS "inventoryValue",
              (SELECT COUNT(*)::int FROM kadiwa_inventory WHERE stock <= reorder_level AND deleted_at IS NULL) AS "lowStockItems"
       FROM kadiwa_sales`
    ),
    goodsForForm({ query }),
  ]);
  return res.json({ success: true, inventory: inventory.rows, sales: sales.rows.map(withLines), pagination: paginationMeta(page, limit, count.rows[0].total), summary: summary.rows[0], goods });
}

// Sales from `from` to `to` (YYYY-MM-DD, inclusive): each sale with its lines,
// and the report for the period, the 15-day or monthly summary of every good sold.
export async function listKadiwaSales(req, res) {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!isValidDateOnly(from) || !isValidDateOnly(to) || from > to) throw badRequest('Choose a valid period: from and to as YYYY-MM-DD, from not after to.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw badRequest('Choose a period of at most one year.');
  const sales = (await query(`${salesSelect} WHERE s.sale_date BETWEEN $1::date AND $2::date AND s.status = 'completed' ORDER BY ${salesOrder} LIMIT 5000`, [from, to])).rows;
  return res.json({ success: true, from, to, sales: sales.map(withLines), report: salesReport(sales) });
}

// Records one sale inside the caller's transaction: writes the goods lines of
// the daily form, locks and decrements the inventory for store items sold,
// and keeps the groceries, vegetables and meat totals that net income and the
// reports read. Shared by the sale form and by OCR-posted Kadiwa sales forms.
export async function insertKadiwaSale(client, req, { encoderName, saleDate = null, manual, expensesCents, items, goods = [], expenseLines = [] }) {
  const totals = { ...manual };
  for (const good of goods) totals[good.category] = (totals[good.category] || 0) + toCents(good.amount);
  const lines = [];
  // Lock every product row in a fixed order so concurrent sales cannot
  // oversell or deadlock.
  const ids = [...new Set(items.map((item) => item.inventoryId))].sort();
  const products = ids.length
    ? (await client.query('SELECT id, name, size_value, size_unit, category, unit, stock, price, cost_price FROM kadiwa_inventory WHERE id = ANY($1::varchar[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE', [ids])).rows
    : [];
  for (const product of products) product.label = productLabel(product.name, product.size_value, product.size_unit);
  const byId = new Map(products.map((product) => [product.id, product]));
  const requested = new Map();
  for (const item of items) {
    const product = byId.get(item.inventoryId);
    if (!product) throw notFound('A selected product no longer exists.');
    requested.set(product.id, (requested.get(product.id) || 0) + toCents(item.quantity));
  }
  for (const [id, quantityCents] of requested) {
    const product = byId.get(id);
    if (quantityCents > toCents(product.stock)) throw conflict(`Not enough stock for ${product.label}: ${Number(product.stock)} ${product.unit} available.`);
    // The cost of goods and the net income need the product's cost price.
    if (product.cost_price === null) throw badRequest(`Set the cost price of ${product.label} before selling it: Edit it in Store Inventory.`);
  }
  let costCents = 0;
  for (const item of items) {
    const product = byId.get(item.inventoryId);
    const line = (await client.query('SELECT ROUND($1::numeric * $2::numeric, 2) AS total, ROUND($1::numeric * $3::numeric, 2) AS cost', [item.quantity, product.price, product.cost_price])).rows[0];
    lines.push({ product, quantity: item.quantity, lineTotal: line.total, lineCost: line.cost });
    totals[product.category] = (totals[product.category] || 0) + toCents(line.total);
    costCents += toCents(line.cost);
  }
  // "Other" items have no dedicated column; they are counted with groceries.
  const groceries = (totals.Groceries || 0) + (totals.Other || 0);
  // Net income of the sale: what was sold, less the expenses and the cost of the store items sold.
  const net = groceries + (totals.Vegetables || 0) + (totals.Meat || 0) - expensesCents - costCents;

  const id = (await client.query(
    `WITH day AS (SELECT COALESCE($8::date, ${SQL_TODAY}) AS sale_date)
     INSERT INTO kadiwa_sales (id, sale_date, encoder_name, groceries, vegetables, meat, total_expenses, cost_of_goods, net_sales, created_by)
     SELECT 'S-' || TO_CHAR(day.sale_date, 'YYYY') || '-' || LPAD(nextval('kadiwa_sale_seq')::text, 5, '0'), day.sale_date,
            $1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $9::numeric, $6::numeric, $7
       FROM day
     RETURNING id`,
    [encoderName, centsToString(groceries), centsToString(totals.Vegetables || 0), centsToString(totals.Meat || 0), centsToString(expensesCents), centsToString(net), currentUserId(req), saleDate, centsToString(costCents)]
  )).rows[0].id;

  if (goods.length) {
    const column = (key) => goods.map((good) => good[key]);
    await client.query(
      `INSERT INTO kadiwa_sale_goods (sale_id, line_no, name, unit, category, price, quantity, amount)
       SELECT $1, g.line_no, g.name, g.unit, g.category, g.price, g.quantity, g.amount
         FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[]) WITH ORDINALITY
              AS g(name, unit, category, price, quantity, amount, line_no)`,
      [id, column('name'), column('unit'), column('category'), column('price'), column('quantity'), column('amount')]
    );
  }
  if (expenseLines.length) {
    await client.query(
      `INSERT INTO kadiwa_sale_expenses (sale_id, line_no, description, amount)
       SELECT $1, e.line_no, e.description, e.amount
         FROM unnest($2::text[], $3::numeric[]) WITH ORDINALITY AS e(description, amount, line_no)`,
      [id, expenseLines.map((line) => line.description), expenseLines.map((line) => line.amount)]
    );
  }
  for (const line of lines) {
    await client.query(
      `INSERT INTO kadiwa_sale_items (sale_id, inventory_id, item_name, category, unit, quantity, unit_price, line_total, unit_cost, line_cost)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric)`,
      [id, line.product.id, line.product.label.slice(0, 200), line.product.category, line.product.unit, line.quantity, line.product.price, line.lineTotal, line.product.cost_price, line.lineCost]
    );
  }
  const lowStock = [];
  for (const [productId, quantityCents] of requested) {
    const updated = await client.query(
      `UPDATE kadiwa_inventory SET stock = stock - $1::numeric, updated_at = NOW() WHERE id = $2 AND stock >= $1::numeric
       RETURNING stock, reorder_level`,
      [centsToString(quantityCents), productId]
    );
    if (!updated.rows[0]) throw conflict('Stock changed while saving the sale. Please try again.');
    if (Number(updated.rows[0].stock) <= Number(updated.rows[0].reorder_level)) lowStock.push(byId.get(productId).label);
  }
  await createAuditLog({
    client,
    user: req.user,
    action: 'KADIWA_SALE_CREATED',
    module: 'Kadiwa',
    entityType: 'kadiwa_sale',
    entityId: id,
    description: `Recorded Kadiwa sale ${id}${encoderName ? ` by ${encoderName}` : ''}`,
    newValues: {
      seller: encoderName, sale_date: saleDate, total_expenses: centsToString(expensesCents), cost_of_goods: centsToString(costCents), net_sales: centsToString(net),
      goods: goods.map((good) => ({ name: good.name, amount: good.amount })),
      expenses: expenseLines.map((line) => ({ description: line.description, amount: line.amount })),
      items: lines.map((line) => ({ id: line.product.id, name: line.product.label, quantity: line.quantity, unit_price: line.product.price, unit_cost: line.product.cost_price, line_total: line.lineTotal, line_cost: line.lineCost })),
    },
    ...getRequestMeta(req),
  });
  if (lowStock.length) {
    await notifyAdmins(client, { type: 'low_stock', title: 'Kadiwa stock is low', message: `${lowStock.join(', ')} ${lowStock.length === 1 ? 'is' : 'are'} at or below the reorder level.`, severity: 'warning', link: '/kadiwa', entityType: 'kadiwa_sale', entityId: id, dedupeKey: `low-stock-${id}` });
  }
  return id;
}

// The date written on a sales form: today when blank, never in the future.
function parseSaleDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!isValidDateOnly(text) || text < '2000-01-01') throw badRequest('Enter the date of the sales as YYYY-MM-DD.');
  if (text > todayDateOnly()) throw badRequest('The date of the sales cannot be in the future.');
  return text;
}

// A sale is the daily sales form: the date, the goods sold (`goods`, each with
// its unit, price, quantity and total amount) and the expenses (`expenses`,
// each with what it was for and the amount; required with the goods, their sum
// is the sale's expenses). Store items sold from the inventory (`items`)
// decrement the stock and count as GROCERIES. The older per-category amounts
// and `totalExpenses` are still accepted. A seller name is optional: without
// one, the sale is recorded under the name of the person who saves it.
export async function createKadiwaSale(req, res) {
  const body = req.body || {};
  const sellerName = cleanString(body.sellerName ?? body.encoderName, 200)
    || cleanString(req.user?.full_name ?? '', 200) || cleanString(req.user?.username ?? '', 200) || 'Administrator';
  const saleDate = parseSaleDate(body.saleDate);
  const goods = parseGoodsLines(body.goods);
  const manual = {};
  for (const [field, category] of [['groceriesPrice', 'Groceries'], ['vegetablesPrice', 'Vegetables'], ['meatPrice', 'Meat']]) {
    const cents = parseMoneyInput(body[field] ?? 0, { allowZero: true });
    if (cents === null) throw badRequest('Sales amounts must be non-negative with at most two decimals.');
    manual[category] = cents;
  }
  const expenseLines = parseExpenseLines(body.expenses);
  if (goods.length && !expenseLines?.length) throw badRequest('Enter the expenses of the sale: what each was for and the amount (0 if there were none).');
  const expensesCents = expenseLines ? expenseLines.reduce((sum, line) => sum + line.cents, 0) : parseMoneyInput(body.totalExpenses ?? 0, { allowZero: true });
  if (expensesCents === null) throw badRequest('Total expenses must be a non-negative amount.');
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  const items = rawItems.map((item) => {
    const quantity = String(item?.quantity ?? '').trim();
    if (!item?.inventoryId || !QUANTITY_PATTERN.test(quantity) || Number(quantity) <= 0) throw badRequest('Each store item needs a product and a quantity greater than zero.');
    return { inventoryId: cleanString(String(item.inventoryId), 30), quantity };
  });
  if (!goods.length && !items.length && Object.values(manual).every((cents) => cents === 0)) throw badRequest('Enter the amount of at least one good sold.');

  const saleId = await withTransaction((client) => insertKadiwaSale(client, req, { encoderName: sellerName, saleDate, manual, expensesCents, items, goods, expenseLines: expenseLines || [] }));
  const sale = await query(`${salesSelect} WHERE s.id = $1`, [saleId]);
  return res.status(201).json({ success: true, sale: withLines(sale.rows[0]) });
}

// Parses one product from the add sheet or the edit form: its name, size
// (150 g, 1.5 L), the unit it is counted in, the quantity, selling price,
// cost price and low-stock level. `prefix` names the sheet row in errors.
function parseInventoryInput(body, { prefix = '' } = {}) {
  const fail = (message) => badRequest(`${prefix}${message}`);
  const name = cleanString(body.name, 200);
  if (!name) throw fail('Enter the product name.');
  const category = body.category || 'Groceries';
  if (!CATEGORIES.includes(category)) throw fail('Choose a valid category.');
  const sizeValue = String(body.sizeValue ?? '').trim() || null;
  if (sizeValue && (!SIZE_PATTERN.test(sizeValue) || Number(sizeValue) <= 0 || Number(sizeValue) > 999999)) throw fail('The size must be a number greater than zero, like 150 or 1.5.');
  const sizeUnit = sizeValue ? SIZE_UNITS[String(body.sizeUnit ?? '').trim().toLowerCase()] || null : null;
  if (sizeValue && !sizeUnit) throw fail('Choose the size unit: mL, L, mg, g or kg.');
  const unit = cleanString(body.unit || 'pc', 40);
  if (!unit) throw fail('Choose what the quantity is counted in.');
  const stock = String(body.stock ?? 0).trim();
  if (!QUANTITY_PATTERN.test(stock)) throw fail('The quantity must be zero or more, with at most two decimals.');
  const priceCents = parseMoneyInput(body.price ?? '', { allowZero: true });
  if (priceCents === null) throw fail('Enter the selling price, with at most two decimals.');
  const costText = String(body.costPrice ?? '').trim();
  if (!costText) throw fail('Enter the cost price.');
  const costCents = parseMoneyInput(costText, { allowZero: true });
  if (costCents === null) throw fail('The cost price must be zero or more, with at most two decimals.');
  const reorderLevel = String(body.reorderLevel ?? 10).trim();
  if (!QUANTITY_PATTERN.test(reorderLevel)) throw fail('The low-stock level must be zero or more.');
  return { name, category, sizeValue, sizeUnit, unit, stock, price: centsToString(priceCents), costPrice: costCents === null ? null : centsToString(costCents), reorderLevel };
}

// The same product is the same name, size and counting unit (Toyo 200 mL by
// the bottle); Toyo 1 L is another product.
const sameProductKey = (item) => [item.name.toLowerCase(), item.sizeValue === null ? '' : Number(item.sizeValue), item.sizeUnit || '', item.unit.toLowerCase()].join('|');

// The first of `items` already in the inventory (other than `exceptId`), or null.
async function findExisting(client, items, exceptId = null) {
  const result = await client.query(
    `SELECT i.ord::int AS ord, k.id
       FROM unnest($1::text[], $2::numeric[], $3::text[], $4::text[]) WITH ORDINALITY AS i(name, size_value, size_unit, unit, ord)
       JOIN kadiwa_inventory k ON LOWER(k.name) = LOWER(i.name) AND k.size_value IS NOT DISTINCT FROM i.size_value
        AND k.size_unit IS NOT DISTINCT FROM i.size_unit AND LOWER(k.unit) = LOWER(i.unit)
      WHERE k.deleted_at IS NULL AND ($5::varchar IS NULL OR k.id <> $5)
      ORDER BY i.ord LIMIT 1`,
    [items.map((item) => item.name), items.map((item) => item.sizeValue), items.map((item) => item.sizeUnit), items.map((item) => item.unit), exceptId]
  );
  return result.rows[0] ? { index: result.rows[0].ord - 1, id: result.rows[0].id } : null;
}

// Adds one product, or a whole sheet of them ({ items: [...] }) like a page of
// the inventory notebook. Nothing is saved when any row is invalid.
export async function createInventoryItem(req, res) {
  const body = req.body || {};
  const rows = Array.isArray(body.items) ? body.items : [body];
  if (!rows.length) throw badRequest('Add at least one product.');
  if (rows.length > MAX_SHEET_ROWS) throw badRequest(`Save at most ${MAX_SHEET_ROWS} products at a time.`);
  const rowLabel = (index) => (rows.length > 1 ? `Row ${index + 1}: ` : '');
  const items = rows.map((row, index) => parseInventoryInput(row && typeof row === 'object' ? row : {}, { prefix: rowLabel(index) }));
  const seen = new Map();
  items.forEach((item, index) => {
    const key = sameProductKey(item);
    if (seen.has(key)) throw badRequest(`${rowLabel(index)}${productLabel(item.name, item.sizeValue, item.sizeUnit)} is already on row ${seen.get(key) + 1}.`);
    seen.set(key, index);
  });

  const created = await withTransaction(async (client) => {
    // One add or edit at a time, so two admins cannot add the same product together.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [INVENTORY_LOCK]);
    const existing = await findExisting(client, items);
    if (existing) {
      const item = items[existing.index];
      throw conflict(`${rowLabel(existing.index)}${productLabel(item.name, item.sizeValue, item.sizeUnit)} (${item.unit}) is already in the inventory as ${existing.id}. Use Restock or Edit instead.`);
    }
    const column = (key) => items.map((item) => item[key]);
    const ids = (await client.query(
      `INSERT INTO kadiwa_inventory (id, name, category, size_value, size_unit, unit, stock, price, cost_price, reorder_level)
       SELECT 'INV-' || LPAD(nextval('kadiwa_inventory_seq')::text, 4, '0'), r.name, r.category, r.size_value, r.size_unit, r.unit, r.stock, r.price, r.cost_price, r.reorder_level
         FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])
              WITH ORDINALITY AS r(name, category, size_value, size_unit, unit, stock, price, cost_price, reorder_level, ord)
        ORDER BY r.ord
       RETURNING id`,
      [column('name'), column('category'), column('sizeValue'), column('sizeUnit'), column('unit'), column('stock'), column('price'), column('costPrice'), column('reorderLevel')]
    )).rows.map((row) => row.id);
    const description = items.length === 1
      ? `Added inventory item ${productLabel(items[0].name, items[0].sizeValue, items[0].sizeUnit)}`
      : `Added ${items.length} inventory items`;
    await createAuditLog({ client, user: req.user, action: 'INVENTORY_CREATED', module: 'Kadiwa', entityType: 'kadiwa_inventory', entityId: ids.length === 1 ? ids[0] : null, description, newValues: items.length === 1 ? { id: ids[0], ...items[0] } : { items: items.map((item, index) => ({ id: ids[index], ...item })) }, ...getRequestMeta(req) });
    return (await client.query(`${inventorySelect} WHERE id = ANY($1::varchar[]) ORDER BY ${inventoryOrder}`, [ids])).rows;
  });
  return res.status(201).json({ success: true, items: created, item: created[0] });
}

// Edits a product. The quantity on hand changes here only to record a physical
// count, and only while it is still what the form was opened with
// (`expectedStock`), so a sale or restock saved in the meantime is never lost.
export async function updateInventoryItem(req, res) {
  const id = cleanString(req.params.id, 30);
  const body = req.body || {};
  const input = parseInventoryInput(body);
  const counted = body.stock === undefined || body.stock === null || String(body.stock).trim() === '' ? null : input.stock;
  const expected = String(body.expectedStock ?? '').trim();
  const item = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [INVENTORY_LOCK]);
    const before = (await client.query(`${inventorySelect} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Inventory item not found.');
    const existing = await findExisting(client, [input], id);
    if (existing) throw conflict(`${productLabel(input.name, input.sizeValue, input.sizeUnit)} (${input.unit}) is already in the inventory as ${existing.id}.`);
    const stockChanged = counted !== null && toCents(counted) !== toCents(before.stock);
    if (stockChanged && (!QUANTITY_PATTERN.test(expected) || toCents(expected) !== toCents(before.stock))) {
      throw conflict(`The quantity of ${productLabel(before.name, before.sizeValue, before.sizeUnit)} is now ${Number(before.stock)} ${before.unit}: a sale or restock was saved while you were editing. Open it again to enter the count.`);
    }
    await client.query(
      `UPDATE kadiwa_inventory
          SET name = $2, category = $3, size_value = $4::numeric, size_unit = $5, unit = $6, price = $7::numeric,
              cost_price = $8::numeric, reorder_level = $9::numeric, stock = COALESCE($10::numeric, stock), updated_at = NOW()
        WHERE id = $1`,
      [id, input.name, input.category, input.sizeValue, input.sizeUnit, input.unit, input.price, input.costPrice, input.reorderLevel, stockChanged ? counted : null]
    );
    const after = (await client.query(`${inventorySelect} WHERE id = $1`, [id])).rows[0];
    const changed = Object.keys(after).filter((key) => key !== 'updatedAt' && String(after[key] ?? '') !== String(before[key] ?? ''));
    if (changed.length) {
      await createAuditLog({
        client, user: req.user, action: stockChanged ? 'INVENTORY_COUNTED' : 'INVENTORY_UPDATED', module: 'Kadiwa', entityType: 'kadiwa_inventory', entityId: id,
        description: `${stockChanged ? 'Counted and updated' : 'Updated'} ${productLabel(after.name, after.sizeValue, after.sizeUnit)}`,
        oldValues: Object.fromEntries(changed.map((key) => [key, before[key]])), newValues: Object.fromEntries(changed.map((key) => [key, after[key]])), ...getRequestMeta(req),
      });
    }
    return after;
  });
  return res.json({ success: true, item });
}

// Deletes a product. One never sold is removed. One that was sold stays for its
// past sales, marked deleted: it leaves the inventory, its totals and the sale
// forms, and the same product can be added again as a new one.
export async function deleteInventoryItem(req, res) {
  const id = cleanString(req.params.id, 30);
  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [INVENTORY_LOCK]);
    const before = (await client.query(`${inventorySelect} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Inventory item not found.');
    const pastSales = (await client.query('SELECT COUNT(DISTINCT sale_id)::int AS count FROM kadiwa_sale_items WHERE inventory_id = $1', [id])).rows[0].count;
    if (pastSales) await client.query('UPDATE kadiwa_inventory SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW() WHERE id = $1', [id, currentUserId(req)]);
    else await client.query('DELETE FROM kadiwa_inventory WHERE id = $1', [id]);
    const name = productLabel(before.name, before.sizeValue, before.sizeUnit);
    await createAuditLog({
      client, user: req.user, action: 'INVENTORY_DELETED', module: 'Kadiwa', entityType: 'kadiwa_inventory', entityId: id,
      description: `Deleted ${name}${pastSales ? ` (kept for its ${pastSales} past ${pastSales === 1 ? 'sale' : 'sales'})` : ''}`,
      oldValues: before, newValues: { deleted: true, kept_for_past_sales: pastSales > 0, past_sales: pastSales }, ...getRequestMeta(req),
    });
    return { id, name, keptForPastSales: pastSales > 0, pastSales };
  });
  return res.json({ success: true, ...result });
}

export async function restockInventoryItem(req, res) {
  const quantity = String(req.body?.quantity ?? '').trim();
  if (!QUANTITY_PATTERN.test(quantity) || Number(quantity) <= 0) throw badRequest('Restock quantity must be greater than zero.');
  const id = cleanString(req.params.id, 30);
  const item = await withTransaction(async (client) => {
    const before = (await client.query('SELECT stock, name, size_value, size_unit FROM kadiwa_inventory WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Inventory item not found.');
    await client.query('UPDATE kadiwa_inventory SET stock = stock + $1::numeric, updated_at = NOW() WHERE id = $2', [quantity, id]);
    const after = (await client.query(`${inventorySelect} WHERE id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'INVENTORY_RESTOCKED', module: 'Kadiwa', entityType: 'kadiwa_inventory', entityId: id, description: `Restocked ${productLabel(before.name, before.size_value, before.size_unit)}`, oldValues: { stock: before.stock }, newValues: { stock: after.stock, added: quantity }, ...getRequestMeta(req) });
    return after;
  });
  return res.json({ success: true, item });
}
