import { query, withTransaction } from '../config/db.js';
import { capitalChange, createAuditLog } from '../utils/audit.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, currentUserId, getRequestMeta, notFound, optionalString, parseId } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { displayName } from '../utils/people.js';

// Other income of the cooperative: money that comes in from outside its
// modules (donations, grants, bank interest, rent of the hall, ...), recorded
// by the office. It is part of "Others" in the Dashboard's Net Income and
// Capital (services/netIncome.js). Administrators only.

const MODULE = 'Other Income';
const entrySelect = `
  SELECT o.id, TO_CHAR(o.received_on, 'YYYY-MM-DD') AS "receivedOn", o.source, o.amount, o.reference_number AS reference, o.notes,
         ${displayName('u')} AS "recordedBy", o.created_at AS "createdAt"
  FROM other_income o LEFT JOIN users u ON u.id = o.recorded_by`;
const auditValues = (row) => ({ received_on: row.receivedOn, source: row.source, amount: row.amount, reference_number: row.reference, notes: row.notes });

// GET /api/other-income?from=&to= : the entries, newest first, with their total.
export async function listOtherIncome(req, res) {
  const from = cleanString(req.query.from, 10) || null;
  const to = cleanString(req.query.to, 10) || null;
  if ((from && !isValidDateOnly(from)) || (to && !isValidDateOnly(to))) throw badRequest('The dates must be valid (YYYY-MM-DD).');
  const rows = (await query(
    `${entrySelect} WHERE ($1::date IS NULL OR o.received_on >= $1::date) AND ($2::date IS NULL OR o.received_on <= $2::date)
     ORDER BY o.received_on DESC, o.id DESC LIMIT 500`,
    [from, to]
  )).rows;
  const totalCents = rows.reduce((sum, row) => sum + toCents(row.amount), 0);
  return res.json({ success: true, data: rows, total: centsToString(totalCents) });
}

// POST /api/other-income { receivedOn, source, amount, reference?, notes? }
export async function createOtherIncome(req, res) {
  const body = req.body ?? {};
  const receivedOn = cleanString(body.receivedOn, 10);
  const source = cleanString(body.source, 200);
  const amountCents = parseMoneyInput(body.amount);
  const reference = optionalString(body.reference, 100);
  const notes = cleanString(body.notes, 1000);
  if (!isValidDateOnly(receivedOn)) throw badRequest('Enter the date the money was received.');
  if (receivedOn > todayDateOnly()) throw badRequest('The date received cannot be in the future.');
  if (!source) throw badRequest('Enter where the money came from (e.g., donation, grant, bank interest).');
  if (amountCents === null) throw badRequest('Enter an amount greater than zero, with at most two decimals.');

  const entry = await withTransaction(async (client) => {
    const id = (await client.query(
      `INSERT INTO other_income (received_on, source, amount, reference_number, notes, recorded_by) VALUES ($1, $2, $3::numeric, $4, $5, $6) RETURNING id`,
      [receivedOn, source, centsToString(amountCents), reference, notes, currentUserId(req)]
    )).rows[0].id;
    const row = (await client.query(`${entrySelect} WHERE o.id = $1`, [id])).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'OTHER_INCOME_RECORDED', module: MODULE, entityType: 'other_income', entityId: String(id),
      description: `Recorded other income: ${source}`, newValues: { ...auditValues(row), capital_change: capitalChange(amountCents) }, ...getRequestMeta(req),
    });
    return row;
  });
  return res.status(201).json({ success: true, data: entry, message: 'Other income recorded.' });
}

// DELETE /api/other-income/:id : recorded by mistake. The audit log keeps what it was.
export async function deleteOtherIncome(req, res) {
  const id = parseId(req.params.id, 'entry ID');
  await withTransaction(async (client) => {
    const before = (await client.query(`${entrySelect} WHERE o.id = $1 FOR UPDATE OF o`, [id])).rows[0];
    if (!before) throw notFound('Other income entry not found.');
    await client.query('DELETE FROM other_income WHERE id = $1', [id]);
    await createAuditLog({
      client, user: req.user, action: 'OTHER_INCOME_DELETED', module: MODULE, entityType: 'other_income', entityId: String(id),
      description: `Deleted other income: ${before.source}`, oldValues: auditValues(before), newValues: { capital_change: capitalChange(-toCents(before.amount)) }, ...getRequestMeta(req),
    });
  });
  return res.json({ success: true, message: 'Other income deleted.' });
}
