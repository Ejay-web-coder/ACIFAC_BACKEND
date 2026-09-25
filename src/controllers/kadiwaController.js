import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY, TIME_ZONE } from '../config/env.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, paginationMeta, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { notifyAdmins } from '../services/notificationService.js';

const CATEGORIES = ['Groceries', 'Vegetables', 'Meat', 'Other'];
const CATEGORY_COLUMN = { Groceries: 'groceries', Vegetables: 'vegetables', Meat: 'meat', Other: null };
const QUANTITY_PATTERN = /^\d+(\.\d{1,2})?$/;

const inventorySelect = `
  SELECT id, name, category, stock, price, reorder_level AS "reorderLevel", unit, updated_at AS "updatedAt"
  FROM kadiwa_inventory`;

const salesSelect = `
  SELECT s.id, s.created_at AS date, s.encoder_name AS encoder, s.groceries, s.vegetables, s.meat,
         s.total_expenses AS "totalExpenses", s.net_sales AS "netSales", s.payment_method AS "paymentMethod", s.status,
         COALESCE((SELECT json_agg(json_build_object('inventoryId', i.inventory_id, 'name', i.item_name, 'quantity', i.quantity,
                   'unit', i.unit, 'unitPrice', i.unit_price, 'lineTotal', i.line_total) ORDER BY i.id)
                   FROM kadiwa_sale_items i WHERE i.sale_id = s.id), '[]'::json) AS items
  FROM kadiwa_sales s`;

export async function listKadiwaData(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const [inventory, sales, count, summary] = await Promise.all([
    query(`${inventorySelect} ORDER BY name`),
    query(`${salesSelect} ORDER BY s.created_at DESC, s.id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    query('SELECT COUNT(*)::int AS total FROM kadiwa_sales'),
    query(
      `SELECT COUNT(*) FILTER (WHERE (created_at AT TIME ZONE '${TIME_ZONE}')::date = ${SQL_TODAY})::int AS "todaySales",
              COALESCE(SUM(net_sales) FILTER (WHERE (created_at AT TIME ZONE '${TIME_ZONE}')::date = ${SQL_TODAY}), 0) AS "todayRevenue",
              COALESCE(SUM(net_sales) FILTER (WHERE status = 'completed'), 0) AS "totalNetSales",
              (SELECT COALESCE(SUM(stock * price), 0) FROM kadiwa_inventory) AS "inventoryValue",
              (SELECT COUNT(*)::int FROM kadiwa_inventory WHERE stock <= reorder_level) AS "lowStockItems"
       FROM kadiwa_sales`
    ),
  ]);
  return res.json({ success: true, inventory: inventory.rows, sales: sales.rows, pagination: paginationMeta(page, limit, count.rows[0].total), summary: summary.rows[0] });
}

// Records one sale inside the caller's transaction: locks and decrements
// inventory, writes the sale and its lines. Shared by the sales form and by
// OCR-posted Kadiwa sales forms.
export async function insertKadiwaSale(client, req, { encoderName, manual, expensesCents, items }) {
  const totals = { ...manual };
  const lines = [];
  // Lock every product row in a fixed order so concurrent sales cannot
  // oversell or deadlock.
  const ids = [...new Set(items.map((item) => item.inventoryId))].sort();
  const products = ids.length
    ? (await client.query('SELECT id, name, category, unit, stock, price FROM kadiwa_inventory WHERE id = ANY($1::varchar[]) ORDER BY id FOR UPDATE', [ids])).rows
    : [];
  const byId = new Map(products.map((product) => [product.id, product]));
  const requested = new Map();
  for (const item of items) {
    const product = byId.get(item.inventoryId);
    if (!product) throw notFound('A selected product no longer exists.');
    requested.set(product.id, (requested.get(product.id) || 0) + toCents(item.quantity));
  }
  for (const [id, quantityCents] of requested) {
    const product = byId.get(id);
    if (quantityCents > toCents(product.stock)) throw conflict(`Not enough stock for ${product.name}: ${Number(product.stock)} ${product.unit} available.`);
  }
  for (const item of items) {
    const product = byId.get(item.inventoryId);
    const line = (await client.query('SELECT ROUND($1::numeric * $2::numeric, 2) AS total', [item.quantity, product.price])).rows[0].total;
    lines.push({ product, quantity: item.quantity, lineTotal: line });
    totals[product.category] = (totals[product.category] || 0) + toCents(line);
  }
  // "Other" items have no dedicated column; they are counted with groceries.
  const groceries = (totals.Groceries || 0) + (totals.Other || 0);
  const net = groceries + (totals.Vegetables || 0) + (totals.Meat || 0) - expensesCents;

  const id = (await client.query(
    `INSERT INTO kadiwa_sales (id, encoder_name, groceries, vegetables, meat, total_expenses, net_sales, created_by)
     VALUES ('S-' || TO_CHAR(${SQL_TODAY}, 'YYYY') || '-' || LPAD(nextval('kadiwa_sale_seq')::text, 5, '0'), $1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7)
     RETURNING id`,
    [encoderName, centsToString(groceries), centsToString(totals.Vegetables || 0), centsToString(totals.Meat || 0), centsToString(expensesCents), centsToString(net), currentUserId(req)]
  )).rows[0].id;

  for (const line of lines) {
    await client.query(
      `INSERT INTO kadiwa_sale_items (sale_id, inventory_id, item_name, category, unit, quantity, unit_price, line_total)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric)`,
      [id, line.product.id, line.product.name, line.product.category, line.product.unit, line.quantity, line.product.price, line.lineTotal]
    );
  }
  const lowStock = [];
  for (const [productId, quantityCents] of requested) {
    const updated = await client.query(
      `UPDATE kadiwa_inventory SET stock = stock - $1::numeric, updated_at = NOW() WHERE id = $2 AND stock >= $1::numeric
       RETURNING name, stock, reorder_level`,
      [centsToString(quantityCents), productId]
    );
    if (!updated.rows[0]) throw conflict('Stock changed while saving the sale. Please try again.');
    if (Number(updated.rows[0].stock) <= Number(updated.rows[0].reorder_level)) lowStock.push(updated.rows[0].name);
  }
  await createAuditLog({
    client,
    user: req.user,
    action: 'KADIWA_SALE_CREATED',
    module: 'Kadiwa',
    entityType: 'kadiwa_sale',
    entityId: id,
    description: `Recorded Kadiwa sale ${id}`,
    newValues: { net_sales: centsToString(net), items: lines.map((line) => ({ id: line.product.id, quantity: line.quantity })) },
    ...getRequestMeta(req),
  });
  if (lowStock.length) {
    await notifyAdmins(client, { type: 'low_stock', title: 'Kadiwa stock is low', message: `${lowStock.join(', ')} ${lowStock.length === 1 ? 'is' : 'are'} at or below the reorder level.`, severity: 'warning', link: '/kadiwa', entityType: 'kadiwa_sale', entityId: id, dedupeKey: `low-stock-${id}` });
  }
  return id;
}

// A sale may include inventory items (stock is decremented) plus optional
// manual amounts per category for goods that are not tracked in inventory.
export async function createKadiwaSale(req, res) {
  const body = req.body || {};
  const encoderName = cleanString(body.encoderName, 200);
  if (!encoderName) throw badRequest('Encoder name is required.');
  const manual = {};
  for (const [field, category] of [['groceriesPrice', 'Groceries'], ['vegetablesPrice', 'Vegetables'], ['meatPrice', 'Meat']]) {
    const cents = parseMoneyInput(body[field] ?? 0, { allowZero: true });
    if (cents === null) throw badRequest('Sales amounts must be non-negative with at most two decimals.');
    manual[category] = cents;
  }
  const expensesCents = parseMoneyInput(body.totalExpenses ?? 0, { allowZero: true });
  if (expensesCents === null) throw badRequest('Total expenses must be a non-negative amount.');
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  const items = rawItems.map((item) => {
    const quantity = String(item?.quantity ?? '').trim();
    if (!item?.inventoryId || !QUANTITY_PATTERN.test(quantity) || Number(quantity) <= 0) throw badRequest('Each sold item needs a product and a quantity greater than zero.');
    return { inventoryId: cleanString(String(item.inventoryId), 30), quantity };
  });
  if (!items.length && Object.values(manual).every((cents) => cents === 0)) throw badRequest('Add at least one sold item or sales amount.');

  const saleId = await withTransaction((client) => insertKadiwaSale(client, req, { encoderName, manual, expensesCents, items }));
  const sale = await query(`${salesSelect} WHERE s.id = $1`, [saleId]);
  return res.status(201).json({ success: true, sale: sale.rows[0] });
}

export async function createInventoryItem(req, res) {
  const body = req.body || {};
  const name = cleanString(body.name, 200);
  const category = body.category || 'Groceries';
  const unit = cleanString(body.unit || 'kg', 40);
  const stock = String(body.stock ?? 0).trim();
  const priceCents = parseMoneyInput(body.price ?? 0, { allowZero: true });
  const reorder = String(body.reorderLevel ?? 10).trim();
  if (!name || !CATEGORIES.includes(category) || !unit || priceCents === null || !QUANTITY_PATTERN.test(stock) || !QUANTITY_PATTERN.test(reorder)) {
    throw badRequest('Valid inventory details are required.');
  }
  const item = await withTransaction(async (client) => {
    const duplicate = await client.query('SELECT 1 FROM kadiwa_inventory WHERE LOWER(name) = LOWER($1) AND LOWER(unit) = LOWER($2)', [name, unit]);
    if (duplicate.rows[0]) throw conflict('An inventory item with this name and unit already exists. Use restock instead.');
    const id = (await client.query(
      `INSERT INTO kadiwa_inventory (id, name, category, stock, price, reorder_level, unit)
       VALUES ('INV-' || LPAD(nextval('kadiwa_inventory_seq')::text, 4, '0'), $1, $2, $3::numeric, $4::numeric, $5::numeric, $6) RETURNING id`,
      [name, category, stock, centsToString(priceCents), reorder, unit]
    )).rows[0].id;
    await createAuditLog({ client, user: req.user, action: 'INVENTORY_CREATED', module: 'Kadiwa', entityType: 'kadiwa_inventory', entityId: id, description: `Added inventory item ${name}`, newValues: { name, category, stock, price: centsToString(priceCents), unit }, ...getRequestMeta(req) });
    return (await client.query(`${inventorySelect} WHERE id = $1`, [id])).rows[0];
  });
  return res.status(201).json({ success: true, item });
}

export async function restockInventoryItem(req, res) {
  const quantity = String(req.body?.quantity ?? '').trim();
  if (!QUANTITY_PATTERN.test(quantity) || Number(quantity) <= 0) throw badRequest('Restock quantity must be greater than zero.');
  const id = cleanString(req.params.id, 30);
  const item = await withTransaction(async (client) => {
    const before = (await client.query('SELECT stock, name FROM kadiwa_inventory WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Inventory item not found.');
    await client.query('UPDATE kadiwa_inventory SET stock = stock + $1::numeric, updated_at = NOW() WHERE id = $2', [quantity, id]);
    const after = (await client.query(`${inventorySelect} WHERE id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'INVENTORY_RESTOCKED', module: 'Kadiwa', entityType: 'kadiwa_inventory', entityId: id, description: `Restocked ${before.name}`, oldValues: { stock: before.stock }, newValues: { stock: after.stock, added: quantity }, ...getRequestMeta(req) });
    return after;
  });
  return res.json({ success: true, item });
}
