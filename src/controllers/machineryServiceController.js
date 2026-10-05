// Per-service machinery work for the PhilMech utilization report: jobs done
// for farmers (priced per hectare or per 100 bags from dated rates), their
// payments, operating expenses, beginning cash per cropping, and the report.
// The per-day rental flow stays in machineryController.js.
import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { formatDateOnly, isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import {
  CLIENT_CATEGORIES, CROPPING_PERIODS, SERVICE_UNITS, FeeInputError, computeServiceFee, findRateForDate, rateForClient, toScaled,
} from '../services/machineryFees.js';
import { EXPENSE_CATEGORIES, buildPhilmechReport } from '../services/philmechReport.js';

const PAYMENT_STATUSES = ['unpaid', 'partial', 'full'];

const serviceSelect = `
  SELECT s.id, s.machinery_id AS "machineryId", m.name AS "machineryName", s.service_type AS "serviceType",
         s.service_date AS "serviceDate", s.cropping_period AS "croppingPeriod", s.year,
         s.client_category AS "clientCategory", s.member_id AS "memberDatabaseId", mb.member_number AS "memberNumber",
         s.client_name AS "clientName", s.client_address AS "clientAddress", s.unit,
         s.area_ha AS "areaHa", s.days, s.total_bags AS "totalBags", s.fee_bags AS "feeBags",
         s.bag_value AS "bagValue", s.kg_per_bag AS "kgPerBag", s.price_per_kg AS "pricePerKg",
         s.rate_id AS "rateId", s.rate_used AS "rateUsed", s.computed_fee_amount AS "computedFeeAmount",
         s.fee_amount AS "feeAmount", s.fee_override_reason AS "feeOverrideReason",
         s.amount_paid AS "amountPaid", s.balance, s.payment_status AS "paymentStatus",
         s.rental_request_id AS "rentalRequestId", s.notes, s.created_at AS "createdAt", s.updated_at AS "updatedAt",
         (SELECT MAX(p.payment_date) FROM machinery_service_payments p WHERE p.service_id = s.id) AS "lastPaymentDate"
  FROM machinery_services s
  JOIN machinery m ON m.id = s.machinery_id
  LEFT JOIN members mb ON mb.id = s.member_id`;

const paymentSelect = `
  SELECT p.id, p.service_id AS "serviceId", p.amount, p.payment_date AS "paymentDate", p.notes,
         u.username AS "recordedBy", p.created_at AS "createdAt"
  FROM machinery_service_payments p LEFT JOIN users u ON u.id = p.recorded_by`;

const expenseSelect = `
  SELECT e.id, e.machinery_id AS "machineryId", m.name AS "machineryName", e.expense_date AS "expenseDate",
         e.cropping_period AS "croppingPeriod", e.year, e.category, e.amount, e.description,
         e.created_at AS "createdAt", e.updated_at AS "updatedAt"
  FROM machinery_expenses e JOIN machinery m ON m.id = e.machinery_id`;

const rateSelect = `
  SELECT id, machinery_id AS "machineryId", service_type AS "serviceType", unit, member_rate AS "memberRate",
         non_member_rate AS "nonMemberRate", effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
         (SELECT COUNT(*)::int FROM machinery_services s WHERE s.rate_id = machinery_service_rates.id) AS "servicesUsingRate"
  FROM machinery_service_rates`;

// ----- Input helpers -------------------------------------------------------------

function readPeriod(value, { required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  if (!CROPPING_PERIODS.includes(value)) throw badRequest('Cropping period must be 1st, 2nd or 3rd.');
  return value;
}

function readYear(value, { required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('A valid year is required.');
  return year;
}

function readDate(value, label, { notFuture = true } = {}) {
  const text = cleanString(value, 10);
  if (!isValidDateOnly(text)) throw badRequest(`A valid ${label} is required.`);
  if (notFuture && text > todayDateOnly()) throw badRequest(`The ${label} cannot be in the future.`);
  return text;
}

function readMoney(value, label, { allowZero = true, required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return null;
  const cents = parseMoneyInput(value, { allowZero });
  if (cents === null) throw badRequest(`${label} must be an amount${allowZero ? ' of zero or more' : ' above zero'} with at most 2 decimals.`);
  return cents;
}

// Optional non-negative decimal kept as text for a NUMERIC column.
function readDecimal(value, label, scale) {
  if (value === undefined || value === null || value === '') return null;
  try {
    toScaled(value, scale, label);
  } catch (error) {
    throw badRequest(error.message);
  }
  return String(value).trim();
}

const feeError = (error) => (error instanceof FeeInputError ? badRequest(error.message) : error);

// A quote only needs what the fee depends on: machine, service, date,
// member or non-member, and the quantities.
function readServiceInput(body, { quote = false } = {}) {
  const machineryId = cleanString(body.machineryId, 20);
  if (!machineryId) throw badRequest('Choose the machine.');
  const serviceType = cleanString(body.serviceType, 60);
  if (!serviceType) throw badRequest('Choose the service type.');
  const clientCategory = body.clientCategory;
  if (!CLIENT_CATEGORIES.includes(clientCategory)) throw badRequest('Choose member or non-member.');
  const serviceDate = readDate(body.serviceDate, 'service date');
  const input = {
    machineryId,
    serviceType,
    serviceDate,
    croppingPeriod: quote ? null : readPeriod(body.croppingPeriod),
    year: quote ? null : readYear(body.year),
    clientCategory,
    memberId: clientCategory === 'member' && !quote ? parseId(body.memberDatabaseId, 'member') : null,
    clientName: cleanString(body.clientName, 200),
    clientAddress: cleanString(body.clientAddress, 300),
    areaHa: readDecimal(body.areaHa, 'Area (ha)', 4),
    days: body.days === undefined || body.days === null || body.days === '' ? null : Number(body.days),
    totalBags: readDecimal(body.totalBags, 'Total bags', 2),
    bagValue: readDecimal(body.bagValue, 'Bag value', 2),
    kgPerBag: readDecimal(body.kgPerBag, 'Kg per bag', 2),
    pricePerKg: readDecimal(body.pricePerKg, 'Price per kg', 2),
    feeAmount: readMoney(body.feeAmount, 'Fee', { required: false }),
    feeOverrideReason: cleanString(body.feeOverrideReason, 500),
    rentalRequestId: body.rentalRequestId === undefined || body.rentalRequestId === null || body.rentalRequestId === '' ? null : parseId(body.rentalRequestId, 'rental request'),
    notes: cleanString(body.notes, 1000),
  };
  if (quote) return input;
  if (clientCategory === 'non_member' && !input.clientName) throw badRequest('Enter the non-member\'s name.');
  // A cropping can run into the next calendar year, so one year either side is allowed.
  if (Math.abs(Number(serviceDate.slice(0, 4)) - input.year) > 1) throw badRequest('The year does not match the service date.');
  return input;
}

// Finds the machine and the rate valid on the service date, then computes the fee.
async function priceService(db, input) {
  const machine = (await db.query('SELECT id, name, pricing_mode FROM machinery WHERE id = $1', [input.machineryId])).rows[0];
  if (!machine) throw notFound('Machinery not found.');
  const rates = (await db.query(`${rateSelect} WHERE machinery_id = $1 AND lower(service_type) = lower($2)`, [machine.id, input.serviceType])).rows;
  if (!rates.length) throw badRequest(`${machine.name} has no ${input.serviceType} rate. Add it in the machine's rates first.`);
  const rate = findRateForDate(rates, input.serviceType, input.serviceDate);
  if (!rate) throw badRequest(`No ${rates[0].serviceType} rate for ${machine.name} covers ${formatDateOnly(input.serviceDate)}. Add a rate for that date first.`);
  try {
    const fee = computeServiceFee({ unit: rate.unit, rate: rateForClient(rate, input.clientCategory), ...input });
    return { machine, rate, fee };
  } catch (error) {
    throw feeError(error);
  }
}

// Applies an optional fee change: the computed fee is kept for the report.
function settleFee(input, fee) {
  const computedCents = toCents(fee.feeAmount);
  if (input.feeAmount === null || input.feeAmount === computedCents) {
    return { feeAmount: fee.feeAmount, computedFeeAmount: null, feeOverrideReason: null };
  }
  if (!input.feeOverrideReason) throw badRequest('Give a reason for changing the fee from the rate.');
  return { feeAmount: centsToString(input.feeAmount), computedFeeAmount: fee.feeAmount, feeOverrideReason: input.feeOverrideReason };
}

async function resolveClient(db, input) {
  if (input.clientCategory === 'non_member') return { memberId: null, clientName: input.clientName, clientAddress: input.clientAddress };
  const member = (await db.query(
    `SELECT id, TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name, address FROM members WHERE id = $1 AND status <> 'archived'`,
    [input.memberId]
  )).rows[0];
  if (!member) throw badRequest('Member record not found.');
  return { memberId: member.id, clientName: member.full_name, clientAddress: input.clientAddress || member.address || '' };
}

async function assertRentalRequest(db, rentalRequestId, machineryId) {
  if (!rentalRequestId) return;
  const row = (await db.query(
    `SELECT r.id FROM rental_requests r JOIN machinery m ON m.id = r.machinery_id
     WHERE r.id = $1 AND (m.id = $2 OR m.parent_machinery_id = $2)`,
    [rentalRequestId, machineryId]
  )).rows[0];
  if (!row) throw badRequest('That rental request is not for this machine.');
}

const auditService = (row) => ({
  machinery_id: row.machineryId, service_type: row.serviceType, service_date: row.serviceDate, cropping_period: row.croppingPeriod, year: row.year,
  client_category: row.clientCategory, client_name: row.clientName, area_ha: row.areaHa, total_bags: row.totalBags, fee_bags: row.feeBags,
  rate_used: row.rateUsed, fee_amount: row.feeAmount, computed_fee_amount: row.computedFeeAmount, fee_override_reason: row.feeOverrideReason,
  amount_paid: row.amountPaid, balance: row.balance, payment_status: row.paymentStatus,
});

// ----- Services ----------------------------------------------------------------------

export async function quoteService(req, res) {
  const input = readServiceInput(req.body || {}, { quote: true });
  const { rate, fee } = await priceService({ query }, input);
  return res.json({
    success: true,
    quote: { ...fee, unit: rate.unit, rate: { id: rate.id, serviceType: rate.serviceType, memberRate: rate.memberRate, nonMemberRate: rate.nonMemberRate, effectiveFrom: rate.effectiveFrom, effectiveTo: rate.effectiveTo } },
  });
}

export async function listServices(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 200 });
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.machineryId) add('s.machinery_id = ?', cleanString(req.query.machineryId, 20));
  if (req.query.croppingPeriod) add('s.cropping_period = ?', readPeriod(req.query.croppingPeriod));
  if (req.query.year) add('s.year = ?', readYear(req.query.year));
  if (req.query.paymentStatus) {
    if (!PAYMENT_STATUSES.includes(req.query.paymentStatus)) throw badRequest('Payment status must be unpaid, partial or full.');
    add('s.payment_status = ?', req.query.paymentStatus);
  }
  if (req.query.search) add(`(s.client_name ILIKE '%' || ? || '%')`, cleanString(req.query.search, 100));
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, totals] = await Promise.all([
    query(`${serviceSelect} ${filter} ORDER BY s.service_date DESC, s.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(s.area_ha), 0) AS "areaHa", COALESCE(SUM(s.fee_amount), 0) AS "feeAmount",
                  COALESCE(SUM(s.amount_paid), 0) AS "amountPaid", COALESCE(SUM(s.balance), 0) AS balance
           FROM machinery_services s ${filter}`, params),
  ]);
  return res.json({ success: true, services: rows.rows, totals: totals.rows[0], pagination: paginationMeta(page, limit, totals.rows[0].count) });
}

export async function getService(req, res) {
  const id = parseId(req.params.id, 'service ID');
  const service = (await query(`${serviceSelect} WHERE s.id = $1`, [id])).rows[0];
  if (!service) throw notFound('Service not found.');
  const payments = (await query(`${paymentSelect} WHERE p.service_id = $1 ORDER BY p.payment_date, p.id`, [id])).rows;
  return res.json({ success: true, service, payments });
}

export async function createService(req, res) {
  const input = readServiceInput(req.body || {});
  const amountPaid = readMoney(req.body?.amountPaid ?? 0, 'Amount paid');
  const paymentDate = amountPaid > 0 ? readDate(req.body?.paymentDate || input.serviceDate, 'payment date') : null;
  const service = await withTransaction(async (client) => {
    const { machine, rate, fee } = await priceService(client, input);
    const settled = settleFee(input, fee);
    if (amountPaid > toCents(settled.feeAmount)) throw badRequest('The amount paid is more than the fee.');
    const who = await resolveClient(client, input);
    await assertRentalRequest(client, input.rentalRequestId, machine.id);
    const inserted = await client.query(
      `INSERT INTO machinery_services (
         machinery_id, service_type, service_date, cropping_period, year, client_category, member_id, client_name, client_address,
         unit, area_ha, days, total_bags, fee_bags, bag_value, kg_per_bag, price_per_kg, rate_id, rate_used,
         computed_fee_amount, fee_amount, fee_override_reason, rental_request_id, recorded_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::numeric, 0), $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING id`,
      [machine.id, rate.serviceType, input.serviceDate, input.croppingPeriod, input.year, input.clientCategory, who.memberId, who.clientName, who.clientAddress,
        rate.unit, input.areaHa, rate.unit === 'per_day' ? input.days : null, rate.unit === 'per_100_bags' ? input.totalBags : null, fee.feeBags, fee.bagValue,
        rate.unit === 'per_100_bags' ? input.kgPerBag : null, rate.unit === 'per_100_bags' ? input.pricePerKg : null, rate.id, fee.rateUsed,
        settled.computedFeeAmount, settled.feeAmount, settled.feeOverrideReason, input.rentalRequestId, currentUserId(req), input.notes]
    );
    const id = inserted.rows[0].id;
    if (amountPaid > 0) {
      await client.query('INSERT INTO machinery_service_payments (service_id, amount, payment_date, notes, recorded_by) VALUES ($1, $2, $3, $4, $5)',
        [id, centsToString(amountPaid), paymentDate, 'Paid when the service was recorded', currentUserId(req)]);
    }
    const row = (await client.query(`${serviceSelect} WHERE s.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_SERVICE_RECORDED', module: 'Machinery', entityType: 'machinery_service', entityId: String(id), description: `Recorded ${row.serviceType} for ${row.clientName} on ${machine.name}`, newValues: auditService(row), ...getRequestMeta(req) });
    return row;
  });
  return res.status(201).json({ success: true, service });
}

export async function updateService(req, res) {
  const id = parseId(req.params.id, 'service ID');
  const input = readServiceInput(req.body || {});
  const service = await withTransaction(async (client) => {
    const before = (await client.query(`${serviceSelect} WHERE s.id = $1 FOR UPDATE OF s`, [id])).rows[0];
    if (!before) throw notFound('Service not found.');
    const { machine, rate, fee } = await priceService(client, input);
    const settled = settleFee(input, fee);
    if (toCents(settled.feeAmount) < toCents(before.amountPaid)) {
      throw conflict(`₱${Number(before.amountPaid).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was already collected, so the fee cannot be lower than that. Void a payment first.`);
    }
    const who = await resolveClient(client, input);
    await assertRentalRequest(client, input.rentalRequestId, machine.id);
    await client.query(
      `UPDATE machinery_services SET machinery_id = $2, service_type = $3, service_date = $4, cropping_period = $5, year = $6, client_category = $7,
         member_id = $8, client_name = $9, client_address = $10, unit = $11, area_ha = COALESCE($12::numeric, 0), days = $13, total_bags = $14, fee_bags = $15,
         bag_value = $16, kg_per_bag = $17, price_per_kg = $18, rate_id = $19, rate_used = $20, computed_fee_amount = $21, fee_amount = $22,
         fee_override_reason = $23, rental_request_id = $24, notes = $25, updated_at = NOW()
       WHERE id = $1`,
      [id, machine.id, rate.serviceType, input.serviceDate, input.croppingPeriod, input.year, input.clientCategory, who.memberId, who.clientName, who.clientAddress,
        rate.unit, input.areaHa, rate.unit === 'per_day' ? input.days : null, rate.unit === 'per_100_bags' ? input.totalBags : null, fee.feeBags, fee.bagValue,
        rate.unit === 'per_100_bags' ? input.kgPerBag : null, rate.unit === 'per_100_bags' ? input.pricePerKg : null, rate.id, fee.rateUsed,
        settled.computedFeeAmount, settled.feeAmount, settled.feeOverrideReason, input.rentalRequestId, input.notes]
    );
    const row = (await client.query(`${serviceSelect} WHERE s.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_SERVICE_UPDATED', module: 'Machinery', entityType: 'machinery_service', entityId: String(id), description: `Updated ${row.serviceType} service for ${row.clientName}`, oldValues: auditService(before), newValues: auditService(row), ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, service });
}

export async function deleteService(req, res) {
  const id = parseId(req.params.id, 'service ID');
  await withTransaction(async (client) => {
    const before = (await client.query(`${serviceSelect} WHERE s.id = $1 FOR UPDATE OF s`, [id])).rows[0];
    if (!before) throw notFound('Service not found.');
    if (toCents(before.amountPaid) > 0) throw conflict('This service has payments. Void its payments first so the collections stay on record.');
    await client.query('DELETE FROM machinery_services WHERE id = $1', [id]);
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_SERVICE_DELETED', module: 'Machinery', entityType: 'machinery_service', entityId: String(id), description: `Deleted ${before.serviceType} service for ${before.clientName}`, oldValues: auditService(before), ...getRequestMeta(req) });
  });
  return res.json({ success: true, message: 'Service deleted.' });
}

// ----- Payments --------------------------------------------------------------------------

export async function receivePayment(req, res) {
  const id = parseId(req.params.id, 'service ID');
  const amount = readMoney(req.body?.amount, 'Payment', { allowZero: false });
  const paymentDate = readDate(req.body?.paymentDate, 'payment date');
  const notes = cleanString(req.body?.notes, 500);
  const result = await withTransaction(async (client) => {
    const before = (await client.query(`${serviceSelect} WHERE s.id = $1 FOR UPDATE OF s`, [id])).rows[0];
    if (!before) throw notFound('Service not found.');
    if (amount > toCents(before.balance)) throw badRequest(`The payment is more than the balance of ₱${Number(before.balance).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`);
    const payment = (await client.query(
      'INSERT INTO machinery_service_payments (service_id, amount, payment_date, notes, recorded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [id, centsToString(amount), paymentDate, notes, currentUserId(req)]
    )).rows[0];
    const service = (await client.query(`${serviceSelect} WHERE s.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_SERVICE_PAYMENT_RECEIVED', module: 'Machinery', entityType: 'machinery_service_payment', entityId: String(payment.id), description: `Received payment from ${service.clientName} for ${service.serviceType}`, oldValues: { amount_paid: before.amountPaid, balance: before.balance, payment_status: before.paymentStatus }, newValues: { amount: centsToString(amount), payment_date: paymentDate, amount_paid: service.amountPaid, balance: service.balance, payment_status: service.paymentStatus }, ...getRequestMeta(req) });
    return service;
  });
  const payments = (await query(`${paymentSelect} WHERE p.service_id = $1 ORDER BY p.payment_date, p.id`, [id])).rows;
  return res.status(201).json({ success: true, service: result, payments });
}

export async function voidPayment(req, res) {
  const id = parseId(req.params.id, 'service ID');
  const paymentId = parseId(req.params.paymentId, 'payment ID');
  const result = await withTransaction(async (client) => {
    await client.query('SELECT id FROM machinery_services WHERE id = $1 FOR UPDATE', [id]);
    const payment = (await client.query('SELECT * FROM machinery_service_payments WHERE id = $1 AND service_id = $2', [paymentId, id])).rows[0];
    if (!payment) throw notFound('Payment not found.');
    await client.query('DELETE FROM machinery_service_payments WHERE id = $1', [paymentId]);
    const service = (await client.query(`${serviceSelect} WHERE s.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_SERVICE_PAYMENT_VOIDED', module: 'Machinery', entityType: 'machinery_service_payment', entityId: String(paymentId), description: `Voided a payment from ${service.clientName} for ${service.serviceType}`, oldValues: { amount: payment.amount, payment_date: payment.payment_date, notes: payment.notes }, newValues: { amount_paid: service.amountPaid, balance: service.balance, payment_status: service.paymentStatus }, ...getRequestMeta(req) });
    return service;
  });
  const payments = (await query(`${paymentSelect} WHERE p.service_id = $1 ORDER BY p.payment_date, p.id`, [id])).rows;
  return res.json({ success: true, service: result, payments });
}

// ----- Expenses ----------------------------------------------------------------------------

function readExpenseInput(body) {
  const machineryId = cleanString(body.machineryId, 20);
  if (!machineryId) throw badRequest('Choose the machine.');
  if (!EXPENSE_CATEGORIES.includes(body.category)) throw badRequest('Category must be fuel, labor, repair & maintenance or other.');
  return {
    machineryId,
    expenseDate: readDate(body.expenseDate, 'expense date'),
    croppingPeriod: readPeriod(body.croppingPeriod),
    year: readYear(body.year),
    category: body.category,
    amount: centsToString(readMoney(body.amount, 'Amount', { allowZero: false })),
    description: cleanString(body.description, 1000),
  };
}

export async function listExpenses(req, res) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.machineryId) add('e.machinery_id = ?', cleanString(req.query.machineryId, 20));
  if (req.query.croppingPeriod) add('e.cropping_period = ?', readPeriod(req.query.croppingPeriod));
  if (req.query.year) add('e.year = ?', readYear(req.query.year));
  if (req.query.category) {
    if (!EXPENSE_CATEGORIES.includes(req.query.category)) throw badRequest('Unknown expense category.');
    add('e.category = ?', req.query.category);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, totals] = await Promise.all([
    query(`${expenseSelect} ${filter} ORDER BY e.expense_date DESC, e.id DESC LIMIT 1000`, params),
    query(`SELECT e.category, COALESCE(SUM(e.amount), 0) AS amount FROM machinery_expenses e ${filter} GROUP BY e.category`, params),
  ]);
  const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((category) => [category, totals.rows.find((row) => row.category === category)?.amount ?? '0.00']));
  const total = centsToString(Object.values(byCategory).reduce((sum, value) => sum + toCents(value), 0));
  return res.json({ success: true, expenses: rows.rows, totals: { ...byCategory, total } });
}

async function assertMachine(db, machineryId) {
  const machine = (await db.query('SELECT id, name FROM machinery WHERE id = $1', [machineryId])).rows[0];
  if (!machine) throw notFound('Machinery not found.');
  return machine;
}

const auditExpense = (row) => ({ machinery_id: row.machineryId, expense_date: row.expenseDate, cropping_period: row.croppingPeriod, year: row.year, category: row.category, amount: row.amount, description: row.description });

export async function createExpense(req, res) {
  const input = readExpenseInput(req.body || {});
  const expense = await withTransaction(async (client) => {
    const machine = await assertMachine(client, input.machineryId);
    const id = (await client.query(
      `INSERT INTO machinery_expenses (machinery_id, expense_date, cropping_period, year, category, amount, description, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [machine.id, input.expenseDate, input.croppingPeriod, input.year, input.category, input.amount, input.description, currentUserId(req)]
    )).rows[0].id;
    const row = (await client.query(`${expenseSelect} WHERE e.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_EXPENSE_RECORDED', module: 'Machinery', entityType: 'machinery_expense', entityId: String(id), description: `Recorded ${input.category.replace('_', ' & ')} expense for ${machine.name}`, newValues: auditExpense(row), ...getRequestMeta(req) });
    return row;
  });
  return res.status(201).json({ success: true, expense });
}

export async function updateExpense(req, res) {
  const id = parseId(req.params.id, 'expense ID');
  const input = readExpenseInput(req.body || {});
  const expense = await withTransaction(async (client) => {
    const before = (await client.query(`${expenseSelect} WHERE e.id = $1 FOR UPDATE OF e`, [id])).rows[0];
    if (!before) throw notFound('Expense not found.');
    const machine = await assertMachine(client, input.machineryId);
    await client.query(
      `UPDATE machinery_expenses SET machinery_id = $2, expense_date = $3, cropping_period = $4, year = $5, category = $6, amount = $7, description = $8, updated_at = NOW() WHERE id = $1`,
      [id, machine.id, input.expenseDate, input.croppingPeriod, input.year, input.category, input.amount, input.description]
    );
    const row = (await client.query(`${expenseSelect} WHERE e.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_EXPENSE_UPDATED', module: 'Machinery', entityType: 'machinery_expense', entityId: String(id), description: `Updated expense for ${machine.name}`, oldValues: auditExpense(before), newValues: auditExpense(row), ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, expense });
}

export async function deleteExpense(req, res) {
  const id = parseId(req.params.id, 'expense ID');
  await withTransaction(async (client) => {
    const before = (await client.query(`${expenseSelect} WHERE e.id = $1 FOR UPDATE OF e`, [id])).rows[0];
    if (!before) throw notFound('Expense not found.');
    await client.query('DELETE FROM machinery_expenses WHERE id = $1', [id]);
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_EXPENSE_DELETED', module: 'Machinery', entityType: 'machinery_expense', entityId: String(id), description: `Deleted ${before.category.replace('_', ' & ')} expense for ${before.machineryName}`, oldValues: auditExpense(before), ...getRequestMeta(req) });
  });
  return res.json({ success: true, message: 'Expense deleted.' });
}

// ----- Rates ---------------------------------------------------------------------------------

const auditRate = (row) => ({ machinery_id: row.machineryId, service_type: row.serviceType, unit: row.unit, member_rate: row.memberRate, non_member_rate: row.nonMemberRate, effective_from: row.effectiveFrom, effective_to: row.effectiveTo });

function readRateAmounts(body, partial = false) {
  const values = {};
  if (!partial || body.memberRate !== undefined) values.memberRate = centsToString(readMoney(body.memberRate, 'Member rate'));
  if (!partial || body.nonMemberRate !== undefined) values.nonMemberRate = centsToString(readMoney(body.nonMemberRate, 'Non-member rate'));
  return values;
}

async function assertNoRateOverlap(db, machineryId, serviceType, from, to, excludeId = null) {
  const clash = (await db.query(
    `${rateSelect} WHERE machinery_id = $1 AND lower(service_type) = lower($2) AND ($5::int IS NULL OR id <> $5)
       AND daterange(effective_from, effective_to, '[]') && daterange($3::date, $4::date, '[]') LIMIT 1`,
    [machineryId, serviceType, from, to, excludeId]
  )).rows[0];
  if (clash) {
    throw conflict(`This overlaps the ${clash.serviceType} rate from ${formatDateOnly(clash.effectiveFrom)}${clash.effectiveTo ? ` to ${formatDateOnly(clash.effectiveTo)}` : ' onwards'}.`);
  }
}

export async function listRates(req, res) {
  const machineryId = cleanString(req.params.id, 20);
  const rates = (await query(`${rateSelect} WHERE machinery_id = $1 ORDER BY lower(service_type), effective_from`, [machineryId])).rows;
  return res.json({ success: true, rates });
}

// Adding a rate that starts after an open-ended rate of the same service ends
// that rate the day before, which is how a mid-season rate change is entered.
export async function createRate(req, res) {
  const machineryId = cleanString(req.params.id, 20);
  const body = req.body || {};
  const serviceType = cleanString(body.serviceType, 60);
  if (!serviceType) throw badRequest('Enter the service type, e.g. Rotavator or Harvesting.');
  if (!SERVICE_UNITS.includes(body.unit)) throw badRequest('Unit must be per hectare, per 100 bags or per day.');
  const effectiveFrom = readDate(body.effectiveFrom, 'start date', { notFuture: false });
  const effectiveTo = body.effectiveTo ? readDate(body.effectiveTo, 'end date', { notFuture: false }) : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('The end date cannot be before the start date.');
  const amounts = readRateAmounts(body);
  const rate = await withTransaction(async (client) => {
    const machine = await assertMachine(client, machineryId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`acifac-machinery-rate:${machine.id}:${serviceType.toLowerCase()}`]);
    const sameType = (await client.query(`${rateSelect} WHERE machinery_id = $1 AND lower(service_type) = lower($2) ORDER BY effective_from`, [machine.id, serviceType])).rows;
    if (sameType.length && sameType[0].unit !== body.unit) throw badRequest(`${sameType[0].serviceType} on this machine is charged ${sameType[0].unit.replace(/_/g, ' ')}; use the same unit.`);
    const open = sameType.find((row) => !row.effectiveTo && row.effectiveFrom < effectiveFrom);
    if (open && !effectiveTo && body.closePrevious !== false) {
      const endDate = new Date(`${effectiveFrom}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() - 1);
      const closedTo = endDate.toISOString().slice(0, 10);
      await client.query('UPDATE machinery_service_rates SET effective_to = $2 WHERE id = $1', [open.id, closedTo]);
      await createAuditLog({ client, user: req.user, action: 'MACHINERY_RATE_UPDATED', module: 'Machinery', entityType: 'machinery_service_rate', entityId: String(open.id), description: `Ended the ${open.serviceType} rate for ${machine.name} on ${closedTo}`, oldValues: { effective_to: null }, newValues: { effective_to: closedTo }, ...getRequestMeta(req) });
    }
    await assertNoRateOverlap(client, machine.id, serviceType, effectiveFrom, effectiveTo);
    const id = (await client.query(
      `INSERT INTO machinery_service_rates (machinery_id, service_type, unit, member_rate, non_member_rate, effective_from, effective_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [machine.id, sameType[0]?.serviceType || serviceType, body.unit, amounts.memberRate, amounts.nonMemberRate, effectiveFrom, effectiveTo, currentUserId(req)]
    )).rows[0].id;
    const row = (await client.query(`${rateSelect} WHERE id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_RATE_ADDED', module: 'Machinery', entityType: 'machinery_service_rate', entityId: String(id), description: `Added ${row.serviceType} rate for ${machine.name} from ${effectiveFrom}`, newValues: auditRate(row), ...getRequestMeta(req) });
    return row;
  });
  return res.status(201).json({ success: true, rate });
}

// Recorded services keep the rate they were charged (rate_used), so editing a
// rate never changes past fees.
export async function updateRate(req, res) {
  const id = parseId(req.params.rateId, 'rate ID');
  const body = req.body || {};
  const amounts = readRateAmounts(body, true);
  const rate = await withTransaction(async (client) => {
    const before = (await client.query(`${rateSelect} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Rate not found.');
    const effectiveFrom = body.effectiveFrom !== undefined ? readDate(body.effectiveFrom, 'start date', { notFuture: false }) : before.effectiveFrom;
    const effectiveTo = body.effectiveTo !== undefined ? (body.effectiveTo ? readDate(body.effectiveTo, 'end date', { notFuture: false }) : null) : before.effectiveTo;
    if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest('The end date cannot be before the start date.');
    await assertNoRateOverlap(client, before.machineryId, before.serviceType, effectiveFrom, effectiveTo, id);
    await client.query(
      'UPDATE machinery_service_rates SET member_rate = $2, non_member_rate = $3, effective_from = $4, effective_to = $5 WHERE id = $1',
      [id, amounts.memberRate ?? before.memberRate, amounts.nonMemberRate ?? before.nonMemberRate, effectiveFrom, effectiveTo]
    );
    const row = (await client.query(`${rateSelect} WHERE id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_RATE_UPDATED', module: 'Machinery', entityType: 'machinery_service_rate', entityId: String(id), description: `Updated ${row.serviceType} rate for ${row.machineryId}`, oldValues: auditRate(before), newValues: auditRate(row), ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, rate });
}

export async function deleteRate(req, res) {
  const id = parseId(req.params.rateId, 'rate ID');
  await withTransaction(async (client) => {
    const before = (await client.query(`${rateSelect} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Rate not found.');
    if (before.servicesUsingRate > 0) throw conflict(`${before.servicesUsingRate} recorded service(s) used this rate. End it with an end date instead of deleting it.`);
    await client.query('DELETE FROM machinery_service_rates WHERE id = $1', [id]);
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_RATE_DELETED', module: 'Machinery', entityType: 'machinery_service_rate', entityId: String(id), description: `Deleted ${before.serviceType} rate for ${before.machineryId}`, oldValues: auditRate(before), ...getRequestMeta(req) });
  });
  return res.json({ success: true, message: 'Rate deleted.' });
}

// ----- Beginning cash and other income per cropping -------------------------------------------

const balanceSelect = `
  SELECT b.id, b.machinery_id AS "machineryId", m.name AS "machineryName", b.cropping_period AS "croppingPeriod", b.year,
         b.beginning_cash AS "beginningCash", b.other_income AS "otherIncome", b.notes, b.updated_at AS "updatedAt"
  FROM machinery_period_balances b JOIN machinery m ON m.id = b.machinery_id`;

export async function listPeriodBalances(req, res) {
  const croppingPeriod = readPeriod(req.query.croppingPeriod);
  const year = readYear(req.query.year);
  const rows = (await query(`${balanceSelect} WHERE b.cropping_period = $1 AND b.year = $2 ORDER BY b.machinery_id`, [croppingPeriod, year])).rows;
  return res.json({ success: true, balances: rows });
}

export async function savePeriodBalance(req, res) {
  const body = req.body || {};
  const machineryId = cleanString(body.machineryId, 20);
  const croppingPeriod = readPeriod(body.croppingPeriod);
  const year = readYear(body.year);
  const beginningCash = centsToString(readMoney(body.beginningCash ?? 0, 'Beginning cash'));
  const otherIncome = centsToString(readMoney(body.otherIncome ?? 0, 'Other income'));
  const notes = cleanString(body.notes, 500);
  const balance = await withTransaction(async (client) => {
    const machine = await assertMachine(client, machineryId);
    const before = (await client.query(`${balanceSelect} WHERE b.machinery_id = $1 AND b.cropping_period = $2 AND b.year = $3 FOR UPDATE OF b`, [machine.id, croppingPeriod, year])).rows[0];
    await client.query(
      `INSERT INTO machinery_period_balances (machinery_id, cropping_period, year, beginning_cash, other_income, notes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (machinery_id, cropping_period, year)
       DO UPDATE SET beginning_cash = EXCLUDED.beginning_cash, other_income = EXCLUDED.other_income, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [machine.id, croppingPeriod, year, beginningCash, otherIncome, notes, currentUserId(req)]
    );
    const row = (await client.query(`${balanceSelect} WHERE b.machinery_id = $1 AND b.cropping_period = $2 AND b.year = $3`, [machine.id, croppingPeriod, year])).rows[0];
    await createAuditLog({ client, user: req.user, action: before ? 'MACHINERY_PERIOD_BALANCE_UPDATED' : 'MACHINERY_PERIOD_BALANCE_RECORDED', module: 'Machinery', entityType: 'machinery_period_balance', entityId: String(row.id), description: `Set ${croppingPeriod} cropping ${year} beginning cash for ${machine.name}`, oldValues: before ? { beginning_cash: before.beginningCash, other_income: before.otherIncome } : {}, newValues: { beginning_cash: beginningCash, other_income: otherIncome }, ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, balance });
}

// ----- PhilMech report ---------------------------------------------------------------------------

function readMonth(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw badRequest(`${label} must be a month from 1 to 12.`);
  return month;
}

export async function philmechReport(req, res) {
  const croppingPeriod = readPeriod(req.query.croppingPeriod);
  const year = readYear(req.query.year);
  const fromMonth = readMonth(req.query.fromMonth, 'From month');
  const toMonth = readMonth(req.query.toMonth, 'To month');
  if ((fromMonth === null) !== (toMonth === null)) throw badRequest('Choose both the first and the last month, or neither.');
  if (fromMonth && toMonth < fromMonth) throw badRequest('The last month cannot be before the first month.');
  let machineryId = cleanString(req.query.machineryId, 20) || null;
  if (machineryId) {
    const machine = (await query('SELECT COALESCE(parent_machinery_id, id) AS id FROM machinery WHERE id = $1', [machineryId])).rows[0];
    if (!machine) throw notFound('Machinery not found.');
    machineryId = machine.id;
  }

  // Each record counts under the machine an implement is attached to.
  const owner = (alias) => `COALESCE(${alias}_m.parent_machinery_id, ${alias}_m.id)`;
  const machineFilter = (alias, index) => `($${index}::varchar IS NULL OR ${owner(alias)} = $${index})`;
  const params = [croppingPeriod, year, machineryId];
  const [machines, services, expenses, balances, rates, areaTotals, expenseTotals] = await Promise.all([
    query(`SELECT id, name, type, delivery_date AS "deliveryDate", condition, pricing_mode AS "pricingMode", parent_machinery_id AS "parentMachineryId"
           FROM machinery WHERE $1::varchar IS NULL OR id = $1 OR parent_machinery_id = $1 ORDER BY id`, [machineryId]),
    query(`SELECT s.id, s.machinery_id AS "machineryId", ${owner('s')} AS "reportMachineId", s.service_type AS "serviceType", s.service_date AS "serviceDate",
                  s.client_category AS "clientCategory", s.member_id AS "memberId", s.client_name AS "clientName", s.client_address AS "clientAddress",
                  s.unit, s.area_ha AS "areaHa", s.total_bags AS "totalBags", s.fee_bags AS "feeBags", s.rate_used AS "rateUsed",
                  s.computed_fee_amount AS "computedFeeAmount", s.fee_amount AS "feeAmount", s.fee_override_reason AS "feeOverrideReason",
                  s.amount_paid AS "amountPaid", s.balance, s.payment_status AS "paymentStatus",
                  (SELECT COUNT(*)::int FROM machinery_service_payments p WHERE p.service_id = s.id) AS "paymentCount"
           FROM machinery_services s JOIN machinery s_m ON s_m.id = s.machinery_id
           WHERE s.cropping_period = $1 AND s.year = $2 AND ${machineFilter('s', 3)}`, params),
    query(`SELECT e.id, ${owner('e')} AS "reportMachineId", e.expense_date AS "expenseDate", e.category, e.amount, e.description
           FROM machinery_expenses e JOIN machinery e_m ON e_m.id = e.machinery_id
           WHERE e.cropping_period = $1 AND e.year = $2 AND ${machineFilter('e', 3)}`, params),
    query(`SELECT b.machinery_id AS "machineryId", ${owner('b')} AS "reportMachineId", b.beginning_cash AS "beginningCash", b.other_income AS "otherIncome"
           FROM machinery_period_balances b JOIN machinery b_m ON b_m.id = b.machinery_id
           WHERE b.cropping_period = $1 AND b.year = $2 AND ${machineFilter('b', 3)}`, params),
    query(`SELECT ${owner('r')} AS "reportMachineId", r.service_type AS "serviceType", r.unit, r.member_rate AS "memberRate", r.non_member_rate AS "nonMemberRate",
                  r.effective_from AS "effectiveFrom", r.effective_to AS "effectiveTo"
           FROM machinery_service_rates r JOIN machinery r_m ON r_m.id = r.machinery_id
           WHERE $1::varchar IS NULL OR ${owner('r')} = $1 ORDER BY lower(r.service_type), r.effective_from`, [machineryId]),
    query(`SELECT ${owner('s')} AS "reportMachineId", s.client_category AS category, SUM(s.area_ha) AS area
           FROM machinery_services s JOIN machinery s_m ON s_m.id = s.machinery_id
           WHERE s.cropping_period = $1 AND s.year = $2 AND ${machineFilter('s', 3)} GROUP BY 1, 2`, params),
    query(`SELECT ${owner('e')} AS "reportMachineId", SUM(e.amount) AS amount
           FROM machinery_expenses e JOIN machinery e_m ON e_m.id = e.machinery_id
           WHERE e.cropping_period = $1 AND e.year = $2 AND ${machineFilter('e', 3)} GROUP BY 1`, params),
  ]);

  const aggregates = {};
  for (const row of areaTotals.rows) {
    aggregates[row.reportMachineId] ??= { area: {}, expenses: '0' };
    aggregates[row.reportMachineId].area[row.category] = row.area;
  }
  for (const row of expenseTotals.rows) {
    aggregates[row.reportMachineId] ??= { area: {}, expenses: '0' };
    aggregates[row.reportMachineId].expenses = row.amount;
  }

  const report = buildPhilmechReport({
    croppingPeriod, year, fromMonth, toMonth,
    machines: machines.rows, services: services.rows, expenses: expenses.rows, balances: balances.rows, rates: rates.rows, aggregates,
  });
  return res.json({ success: true, report });
}

// ----- PhilMech report form: header, feedback and signatories per cropping -------------------------

// The "Problems Encountered" boxes of the paper form, in its order.
export const REPORT_PROBLEMS = [
  'low_acceptability', 'officer_conflict', 'management_training',
  'frequent_breakdown', 'high_maintenance_cost', 'not_compatible',
  'unpaid_collectibles', 'lack_operating_capital', 'poor_fund_management',
];

const reportFormSelect = `
  SELECT cropping_period AS "croppingPeriod", year, from_month AS "fromMonth", to_month AS "toMonth", submission_date AS "submissionDate",
         fca_name AS "fcaName", address, contact_person AS "contactPerson", contact_number AS "contactNumber",
         land_preparation AS "landPreparation", harvesting_threshing AS "harvestingThreshing",
         palay_price_fresh AS "palayPriceFresh", palay_price_dry AS "palayPriceDry", problems,
         organization_others AS "organizationOthers", technical_others AS "technicalOthers", financial_others AS "financialOthers",
         other_problems AS "otherProblems", suggested_solutions AS "suggestedSolutions", other_comments AS "otherComments",
         prepared_by AS "preparedBy", prepared_by_position AS "preparedByPosition", approved_by AS "approvedBy", approved_by_position AS "approvedByPosition",
         updated_at AS "updatedAt"
  FROM machinery_report_forms`;

// Land preparation machines (tractor and its implements) and harvest machines, by machine type.
const LAND_PREPARATION_TYPES = '(tractor|rotavator|plow|plough|harrow|tiller|seeder|planter|transplant)';
const HARVEST_TYPES = '(harvest|thresh|reaper)';

export async function getReportForm(req, res) {
  const croppingPeriod = readPeriod(req.query.croppingPeriod);
  const year = readYear(req.query.year);
  const saved = (await query(`${reportFormSelect} WHERE cropping_period = $1 AND year = $2`, [croppingPeriod, year])).rows[0];
  if (saved) return res.json({ success: true, form: { ...saved, saved: true } });

  // A cropping without a form starts from the last form's header and
  // signatories; the type of farm operation follows the machines that served
  // farmers in this cropping.
  const [latest, operations] = await Promise.all([
    query(`${reportFormSelect} ORDER BY updated_at DESC, id DESC LIMIT 1`),
    query(`SELECT COALESCE(bool_or(lower(m.type || ' ' || m.name) ~ $3), FALSE) AS "landPreparation",
                  COALESCE(bool_or(lower(m.type || ' ' || m.name) ~ $4), FALSE) AS "harvestingThreshing"
           FROM machinery_services s JOIN machinery m ON m.id = s.machinery_id
           WHERE s.cropping_period = $1 AND s.year = $2`, [croppingPeriod, year, LAND_PREPARATION_TYPES, HARVEST_TYPES]),
  ]);
  const last = latest.rows[0] || {};
  return res.json({
    success: true,
    form: {
      croppingPeriod, year, fromMonth: null, toMonth: null, submissionDate: null,
      fcaName: last.fcaName ?? '', address: last.address ?? '', contactPerson: last.contactPerson ?? '', contactNumber: last.contactNumber ?? '',
      ...operations.rows[0],
      palayPriceFresh: null, palayPriceDry: null, problems: [],
      organizationOthers: '', technicalOthers: '', financialOthers: '', otherProblems: '', suggestedSolutions: '', otherComments: '',
      preparedBy: last.preparedBy ?? '', preparedByPosition: last.preparedByPosition ?? '', approvedBy: last.approvedBy ?? '', approvedByPosition: last.approvedByPosition ?? '',
      updatedAt: null, saved: false,
    },
  });
}

export async function saveReportForm(req, res) {
  const body = req.body || {};
  const croppingPeriod = readPeriod(body.croppingPeriod);
  const year = readYear(body.year);
  const fromMonth = readMonth(body.fromMonth, 'From month');
  const toMonth = readMonth(body.toMonth, 'To month');
  if ((fromMonth === null) !== (toMonth === null)) throw badRequest('Choose both the first and the last month, or neither.');
  if (fromMonth && toMonth < fromMonth) throw badRequest('The last month cannot be before the first month.');
  // The date of submission may be set ahead of the day the form is handed in.
  const submissionDate = body.submissionDate ? readDate(body.submissionDate, 'date of submission', { notFuture: false }) : null;
  const price = (value, label) => {
    const cents = readMoney(value, label, { required: false });
    return cents === null ? null : centsToString(cents);
  };
  if (body.problems !== undefined && !Array.isArray(body.problems)) throw badRequest('Problems encountered must be a list.');
  const problems = [...new Set(body.problems ?? [])];
  if (problems.some((code) => !REPORT_PROBLEMS.includes(code))) throw badRequest('Unknown problem in Problems Encountered.');

  const form = {
    fromMonth, toMonth, submissionDate,
    fcaName: cleanString(body.fcaName, 200),
    address: cleanString(body.address, 300),
    contactPerson: cleanString(body.contactPerson, 200),
    contactNumber: cleanString(body.contactNumber, 40),
    landPreparation: body.landPreparation === true,
    harvestingThreshing: body.harvestingThreshing === true,
    palayPriceFresh: price(body.palayPriceFresh, 'Fresh palay price'),
    palayPriceDry: price(body.palayPriceDry, 'Dry palay price'),
    problems: REPORT_PROBLEMS.filter((code) => problems.includes(code)),
    organizationOthers: cleanString(body.organizationOthers, 500),
    technicalOthers: cleanString(body.technicalOthers, 500),
    financialOthers: cleanString(body.financialOthers, 500),
    otherProblems: cleanString(body.otherProblems, 1000),
    suggestedSolutions: cleanString(body.suggestedSolutions, 2000),
    otherComments: cleanString(body.otherComments, 2000),
    preparedBy: cleanString(body.preparedBy, 200),
    preparedByPosition: cleanString(body.preparedByPosition, 100),
    approvedBy: cleanString(body.approvedBy, 200),
    approvedByPosition: cleanString(body.approvedByPosition, 100),
  };

  const saved = await withTransaction(async (client) => {
    const before = (await client.query(`${reportFormSelect} WHERE cropping_period = $1 AND year = $2 FOR UPDATE`, [croppingPeriod, year])).rows[0];
    await client.query(
      `INSERT INTO machinery_report_forms (
         cropping_period, year, from_month, to_month, submission_date, fca_name, address, contact_person, contact_number,
         land_preparation, harvesting_threshing, palay_price_fresh, palay_price_dry, problems,
         organization_others, technical_others, financial_others, other_problems, suggested_solutions, other_comments,
         prepared_by, prepared_by_position, approved_by, approved_by_position, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
       ON CONFLICT (cropping_period, year) DO UPDATE SET
         from_month = EXCLUDED.from_month, to_month = EXCLUDED.to_month, submission_date = EXCLUDED.submission_date,
         fca_name = EXCLUDED.fca_name, address = EXCLUDED.address, contact_person = EXCLUDED.contact_person, contact_number = EXCLUDED.contact_number,
         land_preparation = EXCLUDED.land_preparation, harvesting_threshing = EXCLUDED.harvesting_threshing,
         palay_price_fresh = EXCLUDED.palay_price_fresh, palay_price_dry = EXCLUDED.palay_price_dry, problems = EXCLUDED.problems,
         organization_others = EXCLUDED.organization_others, technical_others = EXCLUDED.technical_others, financial_others = EXCLUDED.financial_others,
         other_problems = EXCLUDED.other_problems, suggested_solutions = EXCLUDED.suggested_solutions, other_comments = EXCLUDED.other_comments,
         prepared_by = EXCLUDED.prepared_by, prepared_by_position = EXCLUDED.prepared_by_position,
         approved_by = EXCLUDED.approved_by, approved_by_position = EXCLUDED.approved_by_position,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [croppingPeriod, year, form.fromMonth, form.toMonth, form.submissionDate, form.fcaName, form.address, form.contactPerson, form.contactNumber,
        form.landPreparation, form.harvestingThreshing, form.palayPriceFresh, form.palayPriceDry, form.problems,
        form.organizationOthers, form.technicalOthers, form.financialOthers, form.otherProblems, form.suggestedSolutions, form.otherComments,
        form.preparedBy, form.preparedByPosition, form.approvedBy, form.approvedByPosition, currentUserId(req)]
    );
    const row = (await client.query(`${reportFormSelect} WHERE cropping_period = $1 AND year = $2`, [croppingPeriod, year])).rows[0];
    const audited = ({ updatedAt, ...values }) => values;
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_REPORT_FORM_SAVED', module: 'Machinery', entityType: 'machinery_report_form', entityId: `${year}-${croppingPeriod}`, description: `Saved the PhilMech report form for the ${croppingPeriod} cropping of ${year}`, oldValues: before ? audited(before) : {}, newValues: audited(row), ...getRequestMeta(req) });
    return row;
  });
  return res.json({ success: true, form: { ...saved, saved: true } });
}
