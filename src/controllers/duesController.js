import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { formatDateOnly, isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, optionalString, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, toCents } from '../utils/money.js';
import { notifyMember } from '../services/notificationService.js';
import { DUES, DUES_PAYMENT_METHOD, syncMeetingDues } from '../services/dues.js';
import { insertSavingsDeposit, insertShareContribution } from './memberController.js';
import { displayName } from '../utils/people.js';

// Dues under the Membership Policy: what each member was charged, paid and
// still owes. The office sees every member and records payments, transfer
// fees and waivers; a member sees only their own dues (GET /api/dues/me).

const MODULE = 'Dues';
const MEMBER_NAME = `TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix))`;
const UNPAID = 'd.payment_id IS NULL AND d.waived_at IS NULL';
const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

const dueSelect = `
  SELECT d.id, d.member_id AS "memberId", d.kind, d.amount, d.due_date AS "dueDate", d.activity_id AS "activityId",
         a.title AS "activityTitle", d.description,
         CASE WHEN d.payment_id IS NOT NULL THEN 'paid' WHEN d.waived_at IS NOT NULL THEN 'waived' ELSE 'unpaid' END AS status,
         d.payment_id AS "paymentId", p.payment_date AS "paidOn", d.waived_at AS "waivedAt", d.waive_reason AS "waiveReason",
         ${displayName('wu')} AS "waivedBy", d.created_at AS "createdAt"
  FROM member_dues d
  LEFT JOIN activities a ON a.id = d.activity_id
  LEFT JOIN member_dues_payments p ON p.id = d.payment_id
  LEFT JOIN users wu ON wu.id = d.waived_by`;

const paymentSelect = `
  SELECT p.id, p.member_id AS "memberId", p.amount, p.payment_date AS "paymentDate", p.payment_method AS "paymentMethod",
         p.reference_number AS reference, p.notes, ${displayName('u')} AS "recordedBy", u.position AS "recordedByPosition", p.created_at AS "createdAt",
         (SELECT COUNT(*)::int FROM member_dues d WHERE d.payment_id = p.id) AS "duesCount"
  FROM member_dues_payments p LEFT JOIN users u ON u.id = p.recorded_by`;

// Totals of a set of dues rows (alias d), per state and, unpaid, per kind.
const totalsColumns = `
  COALESCE(SUM(d.amount), 0) AS charged,
  COALESCE(SUM(d.amount) FILTER (WHERE d.payment_id IS NOT NULL), 0) AS paid,
  COALESCE(SUM(d.amount) FILTER (WHERE d.waived_at IS NOT NULL), 0) AS waived,
  COALESCE(SUM(d.amount) FILTER (WHERE ${UNPAID}), 0) AS unpaid,
  COUNT(d.id) FILTER (WHERE ${UNPAID})::int AS "unpaidCount",
  MIN(d.due_date) FILTER (WHERE ${UNPAID}) AS "oldestUnpaid",
  COALESCE(SUM(d.amount) FILTER (WHERE ${UNPAID} AND d.kind = 'share_capital'), 0) AS "unpaidShareCapital",
  COALESCE(SUM(d.amount) FILTER (WHERE ${UNPAID} AND d.kind = 'savings'), 0) AS "unpaidSavings",
  COALESCE(SUM(d.amount) FILTER (WHERE ${UNPAID} AND d.kind = 'absence_fine'), 0) AS "unpaidFines",
  COALESCE(SUM(d.amount) FILTER (WHERE ${UNPAID} AND d.kind = 'transfer_fee'), 0) AS "unpaidFees"`;

const MONEY_FIELDS = ['amount', 'charged', 'paid', 'waived', 'unpaid', 'unpaidShareCapital', 'unpaidSavings', 'unpaidFines', 'unpaidFees'];
const numbers = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, MONEY_FIELDS.includes(key) && value !== null ? Number(value) : value]));

const RATES = Object.fromEntries(Object.entries(DUES).map(([kind, due]) => [kind, { label: due.label, amount: Number(centsToString(due.cents)) }]));

async function memberDues(memberId) {
  const [dues, payments, totals] = await Promise.all([
    query(`${dueSelect} WHERE d.member_id = $1 ORDER BY (d.payment_id IS NULL AND d.waived_at IS NULL) DESC, d.due_date DESC, d.id DESC LIMIT 500`, [memberId]),
    query(`${paymentSelect} WHERE p.member_id = $1 ORDER BY p.payment_date DESC, p.id DESC LIMIT 200`, [memberId]),
    query(`SELECT ${totalsColumns} FROM member_dues d WHERE d.member_id = $1`, [memberId]),
  ]);
  return { summary: numbers(totals.rows[0]), dues: dues.rows.map(numbers), payments: payments.rows.map(numbers), rates: RATES };
}

// GET /api/dues/me: the signed-in member's own dues and payments.
export async function getMyDues(req, res) {
  return res.json({ success: true, ...(await memberDues(Number(req.user.member_id))) });
}

// GET /api/dues?search=&filter=owing|settled|all&page=&limit=
// One row per member: charged, paid, waived and still owed. "owing" (the
// default) lists members with unpaid dues, "settled" those with dues and
// nothing left to pay, "all" every member (terminated ones only with dues).
export async function listMemberDues(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const filter = cleanString(req.query.filter, 10) || 'owing';
  if (!['owing', 'settled', 'all'].includes(filter)) throw badRequest('Filter must be owing, settled or all.');
  const params = [];
  const where = [];
  const search = cleanString(req.query.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(m.member_number ILIKE ${p} OR ${MEMBER_NAME} ILIKE ${p} OR TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) ILIKE ${p} OR TRIM(CONCAT_WS(', ', m.last_name, m.first_name)) ILIKE ${p})`);
  }
  const having = filter === 'owing' ? `HAVING COUNT(d.id) FILTER (WHERE ${UNPAID}) > 0`
    : filter === 'settled' ? `HAVING COUNT(d.id) > 0 AND COUNT(d.id) FILTER (WHERE ${UNPAID}) = 0`
      : `HAVING m.status <> 'archived' OR COUNT(d.id) > 0`;
  const grouped = `
    SELECT m.id AS "memberId", m.member_number AS "memberNumber", ${MEMBER_NAME} AS name, m.status AS "memberStatus",
           ${totalsColumns}, MAX(p.payment_date) AS "lastPaymentDate"
    FROM members m
    LEFT JOIN member_dues d ON d.member_id = m.id
    LEFT JOIN member_dues_payments p ON p.id = d.payment_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY m.id ${having}`;
  const [rows, count, totals] = await Promise.all([
    query(`SELECT * FROM (${grouped}) g ORDER BY g.unpaid DESC, LOWER(g.name), g."memberId" LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM (${grouped}) g`, params),
    query(`SELECT ${totalsColumns}, COUNT(DISTINCT d.member_id) FILTER (WHERE ${UNPAID})::int AS "membersOwing" FROM member_dues d`),
  ]);
  return res.json({ success: true, data: rows.rows.map(numbers), totals: numbers(totals.rows[0]), rates: RATES, pagination: paginationMeta(page, limit, count.rows[0].total) });
}

// GET /api/dues/members/:id
export async function getMemberDues(req, res) {
  const memberId = parseId(req.params.id, 'member ID');
  const member = (await query(`SELECT m.id, m.member_number AS "memberNumber", ${MEMBER_NAME} AS name, m.status FROM members m WHERE m.id = $1`, [memberId])).rows[0];
  if (!member) throw notFound('Member not found.');
  return res.json({ success: true, member: { ...member, id: Number(member.id) }, ...(await memberDues(memberId)) });
}

function readDate(value, label) {
  const text = cleanString(value, 10) || todayDateOnly();
  if (!isValidDateOnly(text)) throw badRequest(`A valid ${label} is required.`);
  if (text > todayDateOnly()) throw badRequest(`The ${label} cannot be in the future.`);
  return text;
}

// POST /api/dues/payments { memberId, dueIds, paymentDate?, paymentMethod?, reference?, notes? }
// Pays the chosen dues in full. Share capital dues become one share capital
// contribution (the 10% limit applies) and savings dues one savings deposit,
// so the member's share capital and savings stay right; fines and fees are
// income of the cooperative.
export async function recordDuesPayment(req, res) {
  const memberId = parseId(req.body?.memberId, 'member');
  const raw = Array.isArray(req.body?.dueIds) ? req.body.dueIds : [];
  const dueIds = [...new Set(raw.map(Number))];
  if (!dueIds.length) throw badRequest('Choose the dues being paid.');
  if (dueIds.length > 200 || dueIds.some((id) => !Number.isInteger(id) || id <= 0)) throw badRequest('Some of the dues chosen are not valid.');
  const paymentDate = readDate(req.body?.paymentDate, 'payment date');
  const paymentMethod = cleanString(req.body?.paymentMethod, 50) || DUES_PAYMENT_METHOD;
  if (paymentMethod !== DUES_PAYMENT_METHOD) throw badRequest('Dues are paid in cash only.');
  const reference = optionalString(req.body?.reference, 100);
  const notes = cleanString(req.body?.notes, 1000);

  const result = await withTransaction(async (client) => {
    const member = (await client.query('SELECT id, member_number, status FROM members WHERE id = $1 FOR UPDATE', [memberId])).rows[0];
    if (!member) throw notFound('Member not found.');
    const dues = (await client.query('SELECT * FROM member_dues WHERE id = ANY($1::int[]) AND member_id = $2 ORDER BY due_date, id FOR UPDATE', [dueIds, memberId])).rows;
    if (dues.length !== dueIds.length) throw badRequest('Some of the dues chosen were not found for this member.');
    if (dues.some((due) => due.payment_id || due.waived_at)) throw conflict('Some of the dues chosen are already paid or waived. Refresh the list and try again.');
    const latest = dues.reduce((max, due) => (due.due_date > max ? due.due_date : max), dues[0].due_date);
    if (paymentDate < latest) throw badRequest(`The payment date cannot be before ${formatDateOnly(latest)}, the date of the latest due being paid.`);

    const sum = (kind) => dues.filter((due) => !kind || due.kind === kind).reduce((total, due) => total + toCents(due.amount), 0);
    const totalCents = sum();
    const note = notes || `Dues paid at the office (${dues.length} ${dues.length === 1 ? 'due' : 'dues'}).`;
    let shareContributionId = null;
    let savingsTransactionId = null;
    if (sum('share_capital')) {
      const share = await insertShareContribution(client, req, memberId, { amountCents: sum('share_capital'), contributionDate: paymentDate, paymentMethod, referenceNumber: reference, notes: `Meeting dues: ${note}` });
      shareContributionId = share.contribution.id;
    }
    if (sum('savings')) {
      const savings = await insertSavingsDeposit(client, req, { memberId, amountCents: sum('savings'), date: paymentDate, paymentMethod, reference, notes: `Meeting dues: ${note}` });
      savingsTransactionId = savings.record.id;
    }
    const payment = (await client.query(
      `INSERT INTO member_dues_payments (member_id, amount, payment_date, payment_method, reference_number, notes, share_contribution_id, savings_transaction_id, recorded_by)
       VALUES ($1, $2::numeric, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [memberId, centsToString(totalCents), paymentDate, paymentMethod, reference, notes, shareContributionId, savingsTransactionId, currentUserId(req)]
    )).rows[0];
    await client.query('UPDATE member_dues SET payment_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])', [payment.id, dueIds]);
    await createAuditLog({
      client, user: req.user, action: 'DUES_PAYMENT_RECORDED', module: MODULE, entityType: 'member_dues_payment', entityId: String(payment.id),
      description: `Recorded a dues payment of ${pesos(totalCents)} for member ${member.member_number || memberId} (${dues.length} ${dues.length === 1 ? 'due' : 'dues'})`,
      newValues: { member_id: memberId, amount: centsToString(totalCents), payment_date: paymentDate, payment_method: paymentMethod, reference_number: reference, due_ids: dueIds, share_contribution_id: shareContributionId, savings_transaction_id: savingsTransactionId },
      ...getRequestMeta(req),
    });
    await notifyMember(client, memberId, {
      type: 'dues_paid', title: 'Dues payment recorded', severity: 'success', link: '/member/dues',
      message: `A payment of ${pesos(totalCents)} for ${dues.length} ${dues.length === 1 ? 'due' : 'dues'} was recorded on ${formatDateOnly(paymentDate)}.`,
      entityType: 'member_dues_payment', entityId: payment.id, dedupeKey: `dues-payment-${payment.id}`,
    });
    return { id: payment.id, amount: Number(centsToString(totalCents)) };
  });
  return res.status(201).json({ success: true, message: `Payment of ${pesos(Math.round(result.amount * 100))} recorded.`, payment: result, ...(await memberDues(memberId)) });
}

// POST /api/dues/transfer-fee { memberId, transferTo, date?, notes? }
// The PHP 500 fee when a membership is transferred to someone else.
export async function addTransferFee(req, res) {
  const memberId = parseId(req.body?.memberId, 'member');
  const transferTo = cleanString(req.body?.transferTo, 200);
  if (!transferTo) throw badRequest('Enter who the membership is transferred to.');
  const date = readDate(req.body?.date, 'date');
  const notes = cleanString(req.body?.notes, 500);
  const fee = DUES.transfer_fee;
  await withTransaction(async (client) => {
    const member = (await client.query('SELECT id, member_number, status FROM members WHERE id = $1 FOR UPDATE', [memberId])).rows[0];
    if (!member) throw notFound('Member not found.');
    const description = `${fee.label}: membership transferred to ${transferTo}${notes ? ` (${notes})` : ''}`.slice(0, 300);
    const due = (await client.query(
      `INSERT INTO member_dues (member_id, kind, amount, due_date, description, created_by) VALUES ($1, 'transfer_fee', $2::numeric, $3, $4, $5) RETURNING id`,
      [memberId, centsToString(fee.cents), date, description, currentUserId(req)]
    )).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'DUES_TRANSFER_FEE_ADDED', module: MODULE, entityType: 'member_due', entityId: String(due.id),
      description: `Added the ${pesos(fee.cents)} transfer fee for member ${member.member_number || memberId} (membership transferred to ${transferTo})`,
      newValues: { member_id: memberId, amount: centsToString(fee.cents), due_date: date, transfer_to: transferTo }, ...getRequestMeta(req),
    });
    await notifyMember(client, memberId, {
      type: 'dues_charged', title: 'Transfer fee', severity: 'info', link: '/member/dues',
      message: `A ${pesos(fee.cents)} transfer fee was added for transferring your membership to ${transferTo}. Please pay at the ACIFAC office.`,
      entityType: 'member_due', entityId: due.id, dedupeKey: `dues-transfer-${due.id}`,
    });
  });
  return res.status(201).json({ success: true, message: 'Transfer fee added.', ...(await memberDues(memberId)) });
}

// PATCH /api/dues/:id/waive { reason }: an unpaid due the board excused.
export async function waiveDue(req, res) {
  const id = parseId(req.params.id, 'due ID');
  const reason = cleanString(req.body?.reason, 500);
  if (reason.length < 3) throw badRequest('Give the reason the due is waived.');
  const memberId = await withTransaction(async (client) => {
    const due = (await client.query('SELECT d.*, m.member_number FROM member_dues d JOIN members m ON m.id = d.member_id WHERE d.id = $1 FOR UPDATE OF d', [id])).rows[0];
    if (!due) throw notFound('Due not found.');
    if (due.payment_id) throw conflict('This due is already paid.');
    if (due.waived_at) throw conflict('This due is already waived.');
    await client.query('UPDATE member_dues SET waived_at = NOW(), waived_by = $2, waive_reason = $3, updated_at = NOW() WHERE id = $1', [id, currentUserId(req), reason]);
    await createAuditLog({
      client, user: req.user, action: 'DUE_WAIVED', module: MODULE, entityType: 'member_due', entityId: String(id),
      description: `Waived the ${pesos(toCents(due.amount))} ${DUES[due.kind].label.toLowerCase()} due of member ${due.member_number || due.member_id}`,
      oldValues: { status: 'unpaid' }, newValues: { status: 'waived', reason }, ...getRequestMeta(req),
    });
    await notifyMember(client, due.member_id, {
      type: 'dues_waived', title: 'Due waived', severity: 'success', link: '/member/dues',
      message: `Your ${pesos(toCents(due.amount))} due (${due.description}) was waived: ${reason}`,
      entityType: 'member_due', entityId: id, dedupeKey: `dues-waived-${id}`,
    });
    return due.member_id;
  });
  return res.json({ success: true, message: 'Due waived.', ...(await memberDues(memberId)) });
}

// GET /api/dues/meetings: meetings with final attendance, newest first, and
// whether their dues were added (meetings finalized before dues existed can
// be charged from here).
export async function listDuesMeetings(req, res) {
  const rows = (await query(
    `SELECT a.id, a.title, a.activity_date AS "activityDate", a.dues_charged_at AS "duesChargedAt",
            (SELECT COUNT(*)::int FROM activity_attendance r WHERE r.activity_id = a.id) AS members,
            (SELECT COUNT(*)::int FROM activity_attendance r WHERE r.activity_id = a.id AND r.attendance_status = 'absent') AS absent,
            COALESCE((SELECT SUM(d.amount) FROM member_dues d WHERE d.activity_id = a.id), 0) AS charged,
            COALESCE((SELECT SUM(d.amount) FROM member_dues d WHERE d.activity_id = a.id AND ${UNPAID}), 0) AS unpaid
     FROM activities a
     WHERE a.category = 'meeting' AND a.status = 'completed' AND a.attendance_finalized_at IS NOT NULL
     ORDER BY a.activity_date DESC, a.id DESC LIMIT 50`
  )).rows;
  return res.json({ success: true, data: rows.map((row) => ({ ...row, charged: Number(row.charged), unpaid: Number(row.unpaid) })), rates: RATES });
}

// POST /api/dues/meetings/:id/charge: adds the dues of a meeting whose
// attendance is final but was finalized before dues were kept.
export async function chargeMeeting(req, res) {
  const id = parseId(req.params.id, 'meeting ID');
  const result = await withTransaction(async (client) => {
    const activity = (await client.query('SELECT * FROM activities WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!activity) throw notFound('Meeting not found.');
    if (activity.category !== 'meeting') throw badRequest('Dues are charged for meetings only.');
    if (!activity.attendance_finalized_at || activity.status !== 'completed') throw badRequest('Finalize the meeting\'s attendance first.');
    if (activity.dues_charged_at) throw conflict('The dues of this meeting were already added.');
    const synced = await syncMeetingDues(client, id, currentUserId(req), { first: true });
    await createAuditLog({
      client, user: req.user, action: 'MEETING_DUES_CHARGED', module: MODULE, entityType: 'activity', entityId: String(id),
      description: `Added the dues of "${activity.title}" on ${formatDateOnly(activity.activity_date)} for ${synced.members} ${synced.members === 1 ? 'member' : 'members'}`,
      details: synced, ...getRequestMeta(req),
    });
    return synced;
  });
  return res.status(201).json({ success: true, message: `Dues added for ${result.members} ${result.members === 1 ? 'member' : 'members'}.`, data: result });
}
