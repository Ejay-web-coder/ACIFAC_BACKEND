import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { createAuditLog } from '../utils/audit.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, optionalString, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput } from '../utils/money.js';
import { notifyAdmins, notifyMember } from '../services/notificationService.js';
import { sendEmailSafely } from '../services/emailService.js';
import { rentalDecisionEmail } from '../services/emailTemplates.js';

// Rental duration keeps the existing ACIFAC rule: days = end_date - start_date,
// minimum 1 (a same-day rental counts as one day). Fee = daily_fee x days.
const DURATION_SQL = 'GREATEST(1, ($2::date - $1::date))';

const requestSelect = `
  SELECT r.id, r.machinery_id AS "machineryId", m.name AS "machineryName",
         r.member_id AS "memberDatabaseId", r.member_name AS "memberName",
         COALESCE(mb.member_number, r.member_id::text) AS "memberId", r.purpose,
         r.start_date AS "startDate", r.end_date AS "endDate", r.duration,
         r.rental_fee AS "rentalFee", r.notes, r.status, r.submitted_at AS "submittedAt", r.reviewed_at AS "reviewedAt"
  FROM rental_requests r
  JOIN machinery m ON m.id = r.machinery_id
  JOIN members mb ON mb.id = r.member_id`;

const operationSelect = `
  SELECT o.id, o.machinery_id AS "machineryId", o.machinery_name AS "machineryName", o.rental_request_id AS "rentalRequestId",
         o.member_name AS "memberName", COALESCE(m.member_number, o.member_id::text) AS "memberId",
         o.purpose, o.start_date AS "startDate", o.end_date AS "endDate", o.duration,
         o.rental_fee AS "rentalFee", o.status, o.created_at AS "createdAt"
  FROM machinery_operations o JOIN members m ON m.id = o.member_id`;

const machinerySelect = `
  SELECT id, name, type, status, acquisition_date AS "acquisitionDate", last_maintenance AS "lastMaintenance",
         next_maintenance AS "nextMaintenance", daily_fee AS "dailyFee", updated_at AS "updatedAt"
  FROM machinery`;

// Operation status follows its dates (completed stays completed), and machine
// availability follows its operations; "maintenance" is only set by an admin.
export async function refreshRentalStatuses(db = null) {
  const run = db ? db.query.bind(db) : query;
  await run(
    `UPDATE machinery_operations SET status = CASE
        WHEN end_date < ${SQL_TODAY} THEN 'completed'
        WHEN start_date <= ${SQL_TODAY} THEN 'ongoing'
        ELSE 'scheduled' END
     WHERE status <> 'completed'
       AND status IS DISTINCT FROM CASE WHEN end_date < ${SQL_TODAY} THEN 'completed' WHEN start_date <= ${SQL_TODAY} THEN 'ongoing' ELSE 'scheduled' END`
  );
  await run(
    `UPDATE machinery m SET status = next.status, updated_at = NOW()
     FROM (
       SELECT mc.id, CASE WHEN EXISTS (SELECT 1 FROM machinery_operations o WHERE o.machinery_id = mc.id AND o.status = 'ongoing') THEN 'in-use' ELSE 'available' END AS status
       FROM machinery mc WHERE mc.status <> 'maintenance'
     ) next
     WHERE m.id = next.id AND m.status IS DISTINCT FROM next.status`
  );
}

async function assertNoOverlap(client, machineryId, startDate, endDate, excludeRequestId = null) {
  const overlap = await client.query(
    `SELECT o.id, o.start_date, o.end_date FROM machinery_operations o
     WHERE o.machinery_id = $1 AND o.status <> 'completed'
       AND o.start_date <= $3::date AND o.end_date >= $2::date
       AND ($4::int IS NULL OR o.rental_request_id IS DISTINCT FROM $4)
     LIMIT 1`,
    [machineryId, startDate, endDate, excludeRequestId]
  );
  if (overlap.rows[0]) {
    throw conflict(`This machine is already booked from ${overlap.rows[0].start_date} to ${overlap.rows[0].end_date}. Choose other dates.`);
  }
}

export async function listMachineryData(req, res) {
  await refreshRentalStatuses();
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const [machinery, requests, operations, operationCount, summary] = await Promise.all([
    query(`${machinerySelect} ORDER BY id`),
    query(`${requestSelect} ORDER BY (r.status = 'pending') DESC, r.submitted_at DESC LIMIT 200`),
    query(`${operationSelect} ORDER BY o.start_date DESC, o.id DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    query('SELECT COUNT(*)::int AS total FROM machinery_operations'),
    query(
      `SELECT COUNT(*)::int AS "totalOperations",
              COUNT(*) FILTER (WHERE status = 'ongoing')::int AS "ongoingOperations",
              COUNT(*) FILTER (WHERE status = 'scheduled')::int AS "scheduledOperations",
              COALESCE(SUM(rental_fee), 0) AS "totalRevenue",
              (SELECT COUNT(*)::int FROM rental_requests WHERE status = 'pending') AS "pendingRequests"
       FROM machinery_operations`
    ),
  ]);
  return res.json({
    success: true,
    machinery: machinery.rows,
    requests: requests.rows,
    operations: operations.rows,
    operationsPagination: paginationMeta(page, limit, operationCount.rows[0].total),
    summary: summary.rows[0],
  });
}

// Minimal catalogue for members: no member data, only availability.
export async function listMachineryCatalog(req, res) {
  await refreshRentalStatuses();
  const result = await query(`SELECT id, name, type, status, daily_fee AS "dailyFee" FROM machinery ORDER BY name`);
  return res.json({ success: true, machinery: result.rows });
}

function readMachineryInput(body, { partial = false } = {}) {
  const values = {};
  if (!partial || body.name !== undefined) {
    values.name = cleanString(body.name, 200);
    if (!values.name) throw badRequest('Machinery name is required.');
  }
  if (!partial || body.type !== undefined) {
    values.type = cleanString(body.type, 80);
    if (!values.type) throw badRequest('Machinery type is required.');
  }
  if (!partial || body.dailyFee !== undefined) {
    const cents = parseMoneyInput(body.dailyFee, { allowZero: true, max: 1000000 });
    if (cents === null) throw badRequest('Daily fee must be a non-negative amount.');
    values.daily_fee = centsToString(cents);
  }
  if (!partial || body.acquisitionDate !== undefined) {
    values.acquisition_date = cleanString(body.acquisitionDate, 10);
    if (!isValidDateOnly(values.acquisition_date)) throw badRequest('A valid acquisition date is required.');
  }
  for (const [key, column] of [['lastMaintenance', 'last_maintenance'], ['nextMaintenance', 'next_maintenance']]) {
    if (body[key] !== undefined) {
      const value = optionalString(body[key], 10);
      if (value && !isValidDateOnly(value)) throw badRequest(`${key} must be a valid date.`);
      values[column] = value;
    }
  }
  if (body.status !== undefined) {
    if (!['available', 'maintenance'].includes(body.status)) throw badRequest('Status can be set to available or maintenance; in-use is set automatically by rentals.');
    values.status = body.status;
  }
  return values;
}

export async function createMachinery(req, res) {
  const values = readMachineryInput(req.body || {});
  const machine = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-machinery-id']);
    const next = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM machinery WHERE id ~ '^M-[0-9]+$'`);
    const id = `M-${String(next.rows[0].n).padStart(3, '0')}`;
    await client.query(
      `INSERT INTO machinery (id, name, type, daily_fee, status, acquisition_date, last_maintenance, next_maintenance)
       VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8)`,
      [id, values.name, values.type, values.daily_fee, values.status || 'available', values.acquisition_date, values.last_maintenance ?? null, values.next_maintenance ?? null]
    );
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_CREATED', module: 'Machinery', entityType: 'machinery', entityId: id, description: `Added machinery ${values.name}`, newValues: values, ...getRequestMeta(req) });
    return (await client.query(`${machinerySelect} WHERE id = $1`, [id])).rows[0];
  });
  return res.status(201).json({ success: true, machinery: machine });
}

export async function updateMachinery(req, res) {
  const id = cleanString(req.params.id, 20);
  const values = readMachineryInput(req.body || {}, { partial: true });
  if (!Object.keys(values).length) throw badRequest('Nothing to update.');
  const machine = await withTransaction(async (client) => {
    const before = (await client.query(`${machinerySelect} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Machinery not found.');
    const columns = Object.keys(values);
    await client.query(
      `UPDATE machinery SET ${columns.map((column, index) => `${column} = $${index + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
      [id, ...columns.map((column) => values[column])]
    );
    if (values.status === 'available') await refreshRentalStatuses(client);
    await createAuditLog({ client, user: req.user, action: 'MACHINERY_UPDATED', module: 'Machinery', entityType: 'machinery', entityId: id, description: `Updated machinery ${before.name}`, oldValues: before, newValues: values, ...getRequestMeta(req) });
    return (await client.query(`${machinerySelect} WHERE id = $1`, [id])).rows[0];
  });
  return res.json({ success: true, machinery: machine });
}

// Inserts a pending rental request inside the caller's transaction. Shared by
// the booking form and by OCR-posted machinery forms.
export async function insertRentalRequest(client, req, { machineryId, memberId, purpose, notes, startDate, endDate }) {
  const machine = (await client.query('SELECT id, name, daily_fee, status FROM machinery WHERE id = $1 FOR UPDATE', [cleanString(String(machineryId), 20)])).rows[0];
  if (!machine) throw notFound('Machinery not found.');
  if (machine.status === 'maintenance') throw conflict('That machinery is under maintenance and cannot be booked right now.');
  await assertNoOverlap(client, machine.id, startDate, endDate);
  const member = (await client.query(`SELECT id, TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name FROM members WHERE id = $1 AND status = 'active'`, [memberId])).rows[0];
  if (!member) throw badRequest('Active member record not found.');
  const inserted = await client.query(
    `INSERT INTO rental_requests (machinery_id, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, notes)
     VALUES ($3, $4, $5, $6, $1::date, $2::date, ${DURATION_SQL}, $7::numeric * ${DURATION_SQL}, $8) RETURNING id`,
    [startDate, endDate, machine.id, member.id, member.full_name, purpose, machine.daily_fee, notes]
  );
  const id = inserted.rows[0].id;
  await createAuditLog({ client, user: req.user, action: 'RENTAL_REQUESTED', module: 'Machinery', entityType: 'rental_request', entityId: String(id), description: `Rental request for ${machine.name} by ${member.full_name}`, newValues: { machinery_id: machine.id, start_date: startDate, end_date: endDate }, ...getRequestMeta(req) });
  await notifyAdmins(client, { type: 'rental_requested', title: 'New rental request', message: `${member.full_name} requested ${machine.name} from ${startDate} to ${endDate}.`, link: '/machinery', entityType: 'rental_request', entityId: id, dedupeKey: `rental-${id}-requested` }, { exceptUserId: req.user.role === 'ADMIN' ? currentUserId(req) : null });
  return (await client.query(`${requestSelect} WHERE r.id = $1`, [id])).rows[0];
}

export async function createRentalRequest(req, res) {
  const { machineryId, memberDatabaseId } = req.body || {};
  const purpose = cleanString(req.body?.purpose, 1000);
  const notes = cleanString(req.body?.notes, 1000);
  const startDate = cleanString(req.body?.startDate, 10);
  const endDate = cleanString(req.body?.endDate, 10);
  if (!machineryId || !purpose || !isValidDateOnly(startDate) || !isValidDateOnly(endDate)) throw badRequest('Machinery, valid dates, and purpose are required.');
  if (endDate < startDate) throw badRequest('End date cannot be before the start date.');
  if (startDate < todayDateOnly()) throw badRequest('Start date cannot be in the past.');
  const requestedMemberId = req.user.role === 'ADMIN' ? parseId(memberDatabaseId, 'member') : Number(req.user.member_id);
  if (!Number.isInteger(requestedMemberId) || requestedMemberId <= 0) throw badRequest('A valid member is required.');

  const request = await withTransaction((client) => insertRentalRequest(client, req, { machineryId, memberId: requestedMemberId, purpose, notes, startDate, endDate }));
  return res.status(201).json({ success: true, request });
}

export async function reviewRentalRequest(req, res) {
  const id = parseId(req.params.id, 'rental request ID');
  const status = req.body?.status;
  if (!['approved', 'declined'].includes(status)) throw badRequest('Invalid request status.');

  const request = await withTransaction(async (client) => {
    const row = (await client.query('SELECT r.*, m.name AS machinery_name FROM rental_requests r JOIN machinery m ON m.id = r.machinery_id WHERE r.id = $1 FOR UPDATE OF r', [id])).rows[0];
    if (!row) throw notFound('Rental request not found.');
    if (row.status !== 'pending') throw conflict('Rental request was already reviewed.');
    if (status === 'approved') {
      // Locking the machine row serialises concurrent approvals for it.
      const machine = (await client.query('SELECT status FROM machinery WHERE id = $1 FOR UPDATE', [row.machinery_id])).rows[0];
      if (machine.status === 'maintenance') throw conflict('This machine is under maintenance. Set it back to available before approving.');
      if (row.end_date < todayDateOnly()) throw badRequest('This request\'s rental period has already passed.');
      await assertNoOverlap(client, row.machinery_id, row.start_date, row.end_date, row.id);
      await client.query(
        `INSERT INTO machinery_operations (rental_request_id, machinery_id, machinery_name, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $7::date <= ${SQL_TODAY} THEN 'ongoing' ELSE 'scheduled' END)`,
        [row.id, row.machinery_id, row.machinery_name, row.member_id, row.member_name, row.purpose, row.start_date, row.end_date, row.duration, row.rental_fee]
      );
    }
    await client.query('UPDATE rental_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3', [status, currentUserId(req), id]);
    await refreshRentalStatuses(client);
    await createAuditLog({ client, user: req.user, action: status === 'approved' ? 'RENTAL_APPROVED' : 'RENTAL_DECLINED', module: 'Machinery', entityType: 'rental_request', entityId: String(id), description: `Rental request ${status} for ${row.member_name}`, oldValues: { status: row.status }, newValues: { status }, ...getRequestMeta(req) });
    await notifyMember(client, row.member_id, {
      type: status === 'approved' ? 'rental_approved' : 'rental_declined',
      title: status === 'approved' ? 'Rental request approved' : 'Rental request declined',
      message: `Your request for ${row.machinery_name} (${row.start_date} to ${row.end_date}) was ${status}.`,
      severity: status === 'approved' ? 'success' : 'error',
      link: '/rental-booking',
      entityType: 'rental_request',
      entityId: id,
      dedupeKey: `rental-${id}-${status}`,
    });
    return row;
  });

  const recipient = (await query(`SELECT u.id AS user_id, COALESCE(u.email, m.email) AS email FROM members m LEFT JOIN users u ON u.member_id = m.id WHERE m.id = $1`, [request.member_id])).rows[0];
  if (recipient?.email) {
    const email = rentalDecisionEmail({ machineryName: request.machinery_name, startDate: request.start_date, endDate: request.end_date, status, rentalFee: request.rental_fee });
    void sendEmailSafely({ ...email, to: recipient.email, relatedUserId: recipient.user_id });
  }
  return res.json({ success: true, message: `Rental request ${status}.` });
}

export async function updateOperationStatus(req, res) {
  const id = parseId(req.params.id, 'operation ID');
  if (req.body?.status !== 'completed') throw badRequest('Operations can only be marked completed manually.');
  const operation = await withTransaction(async (client) => {
    const before = (await client.query('SELECT * FROM machinery_operations WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw notFound('Operation not found.');
    if (before.status === 'completed') throw conflict('Operation is already completed.');
    await client.query(`UPDATE machinery_operations SET status = 'completed' WHERE id = $1`, [id]);
    await refreshRentalStatuses(client);
    await createAuditLog({ client, user: req.user, action: 'OPERATION_COMPLETED', module: 'Machinery', entityType: 'machinery_operation', entityId: String(id), description: `Marked ${before.machinery_name} operation completed`, oldValues: { status: before.status }, newValues: { status: 'completed' }, ...getRequestMeta(req) });
    return (await client.query(`${operationSelect} WHERE o.id = $1`, [id])).rows[0];
  });
  return res.json({ success: true, operation });
}
