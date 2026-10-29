import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, parseId } from '../utils/http.js';
import { parseMoneyInput, centsToString } from '../utils/money.js';

// The rows of the loan form's in-kind table, in its order.
export const FARM_INPUT_CATEGORIES = ['fertilizer', 'pesticides', 'herbicides', 'insecticides', 'seeds', 'plantChemicals'];

const farmInputSelect = `
  SELECT p.id, p.category, p.name, p.unit, p.unit_price AS "unitPrice", p.active, p.updated_at AS "updatedAt", u.username AS "updatedBy"
  FROM farm_input_prices p LEFT JOIN users u ON u.id = p.updated_by`;
const farmInputOrder = `ORDER BY array_position(ARRAY['${FARM_INPUT_CATEGORIES.join("','")}'], p.category::text), lower(p.name), lower(p.unit)`;

// Reads a product from the request; with `partial`, only the fields sent.
function readFarmInput(body, { partial = false } = {}) {
  const values = {};
  if (!partial || body.category !== undefined) {
    if (!FARM_INPUT_CATEGORIES.includes(body.category)) throw badRequest('Choose the kind of farm input: fertilizer, pesticides, herbicides, insecticides, seeds or plant chemicals.');
    values.category = body.category;
  }
  if (!partial || body.name !== undefined) {
    values.name = cleanString(body.name, 500);
    if (!values.name) throw badRequest('Enter the product name or description.');
  }
  if (!partial || body.unit !== undefined) {
    values.unit = cleanString(body.unit, 50);
    if (!values.unit) throw badRequest('Enter the unit, e.g. bag, kg or L.');
  }
  if (!partial || body.unitPrice !== undefined) {
    const cents = parseMoneyInput(body.unitPrice);
    if (cents === null) throw badRequest('Unit price must be greater than zero with at most two decimals.');
    values.unit_price = centsToString(cents);
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw badRequest('Active must be true or false.');
    values.active = body.active;
  }
  return values;
}

const duplicate = (error) => {
  if (error?.code === '23505') throw conflict('This product with this unit is already on the price list.');
  throw error;
};

// GET /api/loans/farm-inputs: the products the loan form offers (active ones).
// An admin may ask for ?all=true to see hidden products too.
export async function listFarmInputs(req, res) {
  const all = req.query.all === 'true' && req.user?.role === 'ADMIN';
  const rows = await query(`${farmInputSelect} ${all ? '' : 'WHERE p.active'} ${farmInputOrder}`);
  return res.json({ success: true, items: rows.rows });
}

// POST /api/admin/farm-inputs { category, name, unit, unitPrice }
export async function createFarmInput(req, res) {
  const values = readFarmInput(req.body || {});
  const item = await withTransaction(async (client) => {
    const id = (await client.query(
      `INSERT INTO farm_input_prices (category, name, unit, unit_price, active, updated_by) VALUES ($1, $2, $3, $4::numeric, $5, $6) RETURNING id`,
      [values.category, values.name, values.unit, values.unit_price, values.active ?? true, currentUserId(req)]
    ).catch(duplicate)).rows[0].id;
    await createAuditLog({ client, user: req.user, action: 'FARM_INPUT_CREATED', module: 'Loans', entityType: 'farm_input_price', entityId: String(id), description: `Added ${values.name} (${values.unit}) to the farm input price list`, newValues: values, ...getRequestMeta(req) });
    return (await client.query(`${farmInputSelect} WHERE p.id = $1`, [id])).rows[0];
  });
  return res.status(201).json({ success: true, item });
}

// PUT /api/admin/farm-inputs/:id { category?, name?, unit?, unitPrice?, active? }
// Changing a price affects new applications only.
export async function updateFarmInput(req, res) {
  const id = parseId(req.params.id, 'farm input ID');
  const values = readFarmInput(req.body || {}, { partial: true });
  if (!Object.keys(values).length) throw badRequest('Nothing to update.');
  const item = await withTransaction(async (client) => {
    const before = (await client.query(`${farmInputSelect} WHERE p.id = $1 FOR UPDATE OF p`, [id])).rows[0];
    if (!before) throw notFound('Farm input not found.');
    const columns = Object.keys(values);
    await client.query(
      `UPDATE farm_input_prices SET ${columns.map((column, index) => `${column} = $${index + 3}`).join(', ')}, updated_by = $2, updated_at = NOW() WHERE id = $1`,
      [id, currentUserId(req), ...columns.map((column) => values[column])]
    ).catch(duplicate);
    await createAuditLog({
      client, user: req.user, action: 'FARM_INPUT_UPDATED', module: 'Loans', entityType: 'farm_input_price', entityId: String(id),
      description: `Updated ${before.name} (${before.unit}) on the farm input price list`,
      oldValues: { category: before.category, name: before.name, unit: before.unit, unit_price: before.unitPrice, active: before.active }, newValues: values, ...getRequestMeta(req),
    });
    return (await client.query(`${farmInputSelect} WHERE p.id = $1`, [id])).rows[0];
  });
  return res.json({ success: true, item });
}
