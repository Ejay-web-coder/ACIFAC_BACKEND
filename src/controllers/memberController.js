import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { createAuditLog } from '../utils/audit.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { AppError, badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, optionalString, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { assertValidUpload, BUCKETS, removeFile, safeOriginalName, sendStoredFile, uploadFile } from '../services/storage.js';
import { notifyMember } from '../services/notificationService.js';
import { DOCUMENT_TYPES, IMAGE_TYPES } from '../middleware/upload.js';
import { loanSelect, paymentSelect, requestSelect } from './loanController.js';
import { refreshLoanStatusesInBackground } from '../services/loanService.js';

const STATUSES = ['active', 'inactive', 'suspended', 'archived'];
const EDITABLE_STATUSES = ['active', 'inactive', 'suspended'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;
// Share capital is recorded as share contributions and capped per member.
// Savings deposits are a separate ledger (savings_transactions).
export const SHARE_CAPITAL_LIMIT = '20000';
export const CONTRIBUTION_METHODS = ['Cash', 'Deposit', 'GCash', 'Bank Transfer', 'Check', 'Initial', 'Legacy', 'Other'];

const memberSelect = `
  SELECT m.id, m.member_number, m.first_name, m.middle_name, m.last_name, m.suffix,
         m.email, m.phone, m.address, m.barangay, m.municipality, m.province,
         m.date_of_birth, m.gender, m.civil_status, m.education, m.id_type, m.id_number,
         m.rsbsa_no, m.livelihood, m.farm_area_ha, m.corn_area_ha, m.palay_area_ha,
         m.yearly_income, m.spouse_name, m.spouse_age, m.spouse_contact, m.children,
         m.emergency_contact, m.id_document_name, m.id_document_type, m.id_document_size,
         (m.id_document_path IS NOT NULL) AS has_id_document, (m.profile_photo IS NOT NULL) AS has_profile_photo,
         m.membership_date, m.share_capital, m.status, m.archived_at, m.archived_by,
         archived_user.username AS archived_by_username, m.created_at, m.updated_at,
         TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS full_name
  FROM members m
  LEFT JOIN users archived_user ON archived_user.id = m.archived_by`;

// Minimal columns for list/search views.
const memberListSelect = `
  SELECT m.id, m.member_number, m.first_name, m.middle_name, m.last_name, m.suffix, m.email, m.phone, m.address,
         m.barangay, m.municipality, m.province, m.date_of_birth, m.gender, m.civil_status, m.livelihood, m.farm_area_ha,
         m.membership_date, m.share_capital, m.status, m.archived_at, archived_user.username AS archived_by_username,
         m.id_document_name, m.created_at, m.updated_at,
         TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS full_name
  FROM members m
  LEFT JOIN users archived_user ON archived_user.id = m.archived_by`;

const shareContributionSelect = `
  SELECT sc.id, sc.member_id AS "memberId", sc.amount, sc.contribution_date AS "contributionDate",
         sc.payment_method AS "paymentMethod", sc.reference_number AS "referenceNumber", sc.notes,
         sc.created_at AS "createdAt", sc.updated_at AS "updatedAt", sc.recorded_by AS "recordedBy",
         u.username AS "recordedByName"
  FROM share_contributions sc
  LEFT JOIN users u ON u.id = sc.recorded_by`;

function numericOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return Number(value);
}

export function validateMemberInput(body) {
  const errors = [];
  const values = {
    firstName: cleanString(body.first_name, 100),
    lastName: cleanString(body.last_name, 100),
    email: cleanString(body.email, 255).toLowerCase(),
    phone: cleanString(body.phone, 50),
    address: cleanString(body.address, 2000),
    membershipDate: cleanString(body.membership_date, 10),
    status: cleanString(body.status, 30) || 'active',
  };
  if (!values.firstName) errors.push('First name is required.');
  if (!values.lastName) errors.push('Last name is required.');
  if (!isValidDateOnly(values.membershipDate)) errors.push('A valid membership date is required.');
  else if (values.membershipDate > todayDateOnly()) errors.push('Membership date cannot be in the future.');
  if (!values.email) errors.push('Email is required.');
  else if (!EMAIL_PATTERN.test(values.email)) errors.push('Email format is invalid.');
  if (!values.phone) errors.push('Phone number is required.');
  else if (!PHONE_PATTERN.test(values.phone)) errors.push('Phone number format is invalid.');
  if (!values.address) errors.push('Address is required.');
  if (!EDITABLE_STATUSES.includes(values.status)) errors.push('Status must be active, inactive, or suspended.');
  if (body.date_of_birth) {
    if (!isValidDateOnly(body.date_of_birth)) errors.push('Date of birth is invalid.');
    else if (body.date_of_birth > todayDateOnly()) errors.push('Date of birth cannot be in the future.');
  }
  for (const field of ['farm_area_ha', 'corn_area_ha', 'palay_area_ha', 'yearly_income']) {
    const amount = numericOrNull(body[field]);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 1e10)) errors.push(`${field.replaceAll('_', ' ')} must be a non-negative number.`);
  }
  if (body.spouse_age !== undefined && body.spouse_age !== null && body.spouse_age !== '' && (!Number.isInteger(Number(body.spouse_age)) || Number(body.spouse_age) < 0 || Number(body.spouse_age) > 130)) {
    errors.push('Spouse age must be a whole number between 0 and 130.');
  }
  return { errors, values };
}

function mapMember(row) {
  return {
    ...row,
    id: Number(row.id),
    share_capital: Number(row.share_capital || 0),
    farm_area_ha: row.farm_area_ha === null || row.farm_area_ha === undefined ? null : Number(row.farm_area_ha),
    corn_area_ha: row.corn_area_ha === null || row.corn_area_ha === undefined ? null : Number(row.corn_area_ha),
    palay_area_ha: row.palay_area_ha === null || row.palay_area_ha === undefined ? null : Number(row.palay_area_ha),
    yearly_income: row.yearly_income === null || row.yearly_income === undefined ? null : Number(row.yearly_income),
  };
}

async function getShareDetails(db, memberId) {
  const runner = db?.query ? db.query.bind(db) : query;
  const result = await runner(`${shareContributionSelect} WHERE sc.member_id = $1 ORDER BY sc.contribution_date DESC, sc.id DESC`, [memberId]);
  const contributions = result.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
  const totalCents = result.rows.reduce((sum, row) => sum + toCents(row.amount), 0);
  const limitCents = toCents(SHARE_CAPITAL_LIMIT);
  return {
    contributions,
    total: Number(centsToString(totalCents)),
    maximum: Number(SHARE_CAPITAL_LIMIT),
    remaining: Number(centsToString(Math.max(0, limitCents - totalCents))),
  };
}

function memberSearchCondition(params, search) {
  params.push(`%${search}%`);
  const p = `$${params.length}`;
  return `(m.first_name ILIKE ${p} OR m.last_name ILIKE ${p} OR m.middle_name ILIKE ${p} OR m.member_number ILIKE ${p} OR m.email ILIKE ${p} OR m.phone ILIKE ${p}
           OR TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name)) ILIKE ${p} OR TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) ILIKE ${p})`;
}

async function sendMemberList(req, res, statusOverride = null) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const search = cleanString(req.query.search, 100);
  const status = statusOverride || cleanString(req.query.status, 20) || 'active';
  const params = [];
  const conditions = [];
  if (status === 'all') conditions.push(`m.status <> 'archived'`);
  else if (STATUSES.includes(status)) { params.push(status); conditions.push(`m.status = $${params.length}`); }
  else throw badRequest('Invalid status filter.');
  if (search) conditions.push(memberSearchCondition(params, search));
  const where = `WHERE ${conditions.join(' AND ')}`;
  const orderBy = status === 'archived' ? 'm.archived_at DESC NULLS LAST, m.id DESC' : 'm.membership_date DESC NULLS LAST, m.id DESC';
  const [result, countResult] = await Promise.all([
    query(`${memberListSelect} ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM members m ${where}`, params),
  ]);
  return res.status(200).json({ success: true, data: result.rows.map(mapMember), pagination: paginationMeta(page, limit, countResult.rows[0].total) });
}

export const listMembers = (req, res) => sendMemberList(req, res);
export const listArchivedMembers = (req, res) => sendMemberList(req, res, 'archived');

export async function getMemberStatistics(req, res) {
  const result = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS "totalMembers",
            COUNT(*) FILTER (WHERE status <> 'archived')::int AS "nonArchivedMembers",
            COUNT(*) FILTER (WHERE status IN ('inactive', 'suspended'))::int AS "inactiveMembers",
            (SELECT COALESCE(SUM(sc.amount), 0) FROM share_contributions sc JOIN members am ON am.id = sc.member_id WHERE am.status = 'active') AS "totalShareCapital",
            COUNT(*) FILTER (WHERE membership_date >= DATE_TRUNC('month', ${SQL_TODAY})::date
                              AND membership_date < (DATE_TRUNC('month', ${SQL_TODAY}) + INTERVAL '1 month')::date
                              AND status = 'active')::int AS "newThisMonth",
            COUNT(*) FILTER (WHERE status = 'archived')::int AS "archivedMembers"
     FROM members`
  );
  const row = result.rows[0];
  return res.status(200).json({ success: true, data: { ...row, totalShareCapital: Number(row.totalShareCapital) } });
}

export async function getMember(req, res) {
  const id = parseId(req.params.id, 'member ID');
  const result = await query(`${memberSelect} WHERE m.id = $1`, [id]);
  if (!result.rows[0]) throw notFound('Member not found.');
  const member = mapMember(result.rows[0]);
  member.shareDetails = await getShareDetails(null, id);
  return res.status(200).json({ success: true, data: member });
}

export async function downloadMemberDocument(req, res) {
  const id = req.params.id === undefined ? Number(req.user.member_id) : parseId(req.params.id, 'member ID');
  if (req.user.role !== 'ADMIN' && id !== Number(req.user.member_id)) throw notFound('Document not found.');
  const kind = req.params.kind;
  if (!['id-document', 'photo'].includes(kind)) throw notFound('Document not found.');
  const result = await query(`SELECT id_document_path, id_document_name, id_document_type, profile_photo FROM members WHERE id = $1`, [id]);
  const row = result.rows[0];
  const reference = kind === 'id-document' ? row?.id_document_path : row?.profile_photo;
  if (!reference) throw notFound('Document not found.');
  const sent = await sendStoredFile(res, {
    reference,
    mimeType: kind === 'id-document' ? row.id_document_type : undefined,
    fileName: kind === 'id-document' ? row.id_document_name : 'profile-photo',
  });
  if (!sent) throw notFound('The stored file could not be found.');
  return undefined;
}

export async function getMyMemberData(req, res) {
  const memberId = Number(req.user?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw notFound('No member record is linked to this account.');
  refreshLoanStatusesInBackground();

  const [memberResult, loansResult, shareDetails, paymentsResult, requestsResult, rentalsResult, savings] = await Promise.all([
    query(`${memberSelect} WHERE m.id = $1 AND m.status <> 'archived'`, [memberId]),
    query(`${loanSelect} WHERE l.member_id = $1 ORDER BY l.created_at DESC, l.id DESC`, [memberId]),
    getShareDetails(null, memberId),
    query(`${paymentSelect} WHERE l.member_id = $1 ORDER BY p.payment_date DESC, p.id DESC LIMIT 200`, [memberId]),
    query(`${requestSelect} WHERE r.member_id = $1 ORDER BY r.submitted_at DESC, r.id DESC LIMIT 100`, [memberId]),
    query(
      `SELECT r.id, r.machinery_id AS "machineryId", mc.name AS "machineryName", r.purpose, r.start_date AS "startDate", r.end_date AS "endDate",
              r.duration, r.rental_fee AS "rentalFee", r.notes, r.status, r.submitted_at AS "submittedAt", r.reviewed_at AS "reviewedAt",
              o.status AS "operationStatus"
       FROM rental_requests r
       JOIN machinery mc ON mc.id = r.machinery_id
       LEFT JOIN machinery_operations o ON o.rental_request_id = r.id
       WHERE r.member_id = $1 ORDER BY r.submitted_at DESC LIMIT 100`,
      [memberId]
    ),
    getSavingsDetails(null, memberId),
  ]);
  if (!memberResult.rows[0]) throw notFound('Linked member record not found.');

  const member = mapMember(memberResult.rows[0]);
  return res.status(200).json({
    success: true,
    data: {
      member: { ...member, share_capital: shareDetails.total, shareDetails },
      loans: loansResult.rows,
      payments: paymentsResult.rows,
      loanRequests: requestsResult.rows,
      rentalRequests: rentalsResult.rows,
      shareDetails,
      savings,
    },
  });
}

// Records a share-capital contribution. The member total is always
// recomputed from share_contributions, which is the source of truth.
async function recordContribution(req, memberId, body) {
  const amountCents = parseMoneyInput(body?.amount);
  const contributionDate = cleanString(body?.contributionDate ?? body?.date, 10);
  const paymentMethod = cleanString(body?.paymentMethod ?? '', 50) || null;
  const referenceNumber = optionalString(body?.referenceNumber ?? body?.reference, 100);
  const notes = cleanString(body?.notes, 1000);
  if (amountCents === null) throw badRequest('Amount must be greater than zero with at most two decimals.');
  if (!isValidDateOnly(contributionDate)) throw badRequest('A valid contribution date (YYYY-MM-DD) is required.');
  if (contributionDate > todayDateOnly()) throw badRequest('Contribution date cannot be in the future.');
  if (paymentMethod && !CONTRIBUTION_METHODS.includes(paymentMethod)) throw badRequest(`Payment method must be one of: ${CONTRIBUTION_METHODS.join(', ')}.`);

  return withTransaction(async (client) => {
    const member = (await client.query('SELECT id, member_number, status, membership_date FROM members WHERE id = $1 FOR UPDATE', [memberId])).rows[0];
    if (!member) throw notFound('Member not found.');
    if (member.status === 'archived') throw badRequest('Contributions cannot be recorded for an archived member.');
    if (referenceNumber) {
      const duplicate = await client.query('SELECT 1 FROM share_contributions WHERE member_id = $1 AND LOWER(reference_number) = LOWER($2)', [memberId, referenceNumber]);
      if (duplicate.rows[0]) throw conflict('A contribution with this reference number was already recorded for this member.');
    }
    const totalResult = await client.query('SELECT COALESCE(SUM(amount), 0) AS total FROM share_contributions WHERE member_id = $1', [memberId]);
    const currentCents = toCents(totalResult.rows[0].total);
    const remainingCents = toCents(SHARE_CAPITAL_LIMIT) - currentCents;
    if (amountCents > remainingCents) {
      throw badRequest(`Share contribution exceeds the PHP 20,000 maximum. Maximum remaining contribution: PHP ${Number(centsToString(Math.max(0, remainingCents))).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`);
    }
    const insert = await client.query(
      `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes, recorded_by)
       VALUES ($1, $2::numeric, $3, $4, $5, $6, $7)
       RETURNING id, member_id AS "memberId", amount, contribution_date AS date, payment_method AS "paymentMethod", reference_number AS reference, notes`,
      [memberId, centsToString(amountCents), contributionDate, paymentMethod, referenceNumber, notes, currentUserId(req)]
    );
    const newTotal = centsToString(currentCents + amountCents);
    await client.query('UPDATE members SET share_capital = $1::numeric, updated_at = NOW() WHERE id = $2', [newTotal, memberId]);
    await createAuditLog({
      client,
      user: req.user,
      action: 'SHARE_CONTRIBUTION_CREATED',
      module: 'Shares',
      entityType: 'share_contribution',
      entityId: String(insert.rows[0].id),
      description: `Recorded share contribution for member ${member.member_number || memberId}`,
      oldValues: { total: centsToString(currentCents) },
      newValues: { member_id: memberId, amount: centsToString(amountCents), total: newTotal, contribution_date: contributionDate, payment_method: paymentMethod, reference_number: referenceNumber },
      ...getRequestMeta(req),
    });
    await notifyMember(client, memberId, {
      type: 'savings_recorded',
      title: 'Share contribution recorded',
      message: `A contribution of PHP ${Number(centsToString(amountCents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was recorded. Your total share capital is PHP ${Number(newTotal).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`,
      severity: 'success',
      link: '/member-profile',
      entityType: 'share_contribution',
      entityId: insert.rows[0].id,
      dedupeKey: `share-contribution-${insert.rows[0].id}`,
    });
    return { contribution: { ...insert.rows[0], amount: Number(insert.rows[0].amount) }, shareDetails: await getShareDetails(client, memberId) };
  });
}

export async function addShareContribution(req, res) {
  const memberId = parseId(req.params.id, 'member ID');
  const result = await recordContribution(req, memberId, req.body);
  return res.status(201).json({ success: true, data: result.shareDetails, contribution: result.contribution, message: 'Share contribution recorded.' });
}

export const SAVINGS_METHODS = ['Cash', 'Deposit', 'GCash', 'Bank Transfer', 'Check', 'Other'];

async function getSavingsDetails(db, memberId) {
  const runner = db?.query ? db.query.bind(db) : query;
  const result = await runner(
    `SELECT st.id, st.amount, st.transaction_type AS "type", st.transaction_date AS "date", st.payment_method AS "paymentMethod",
            st.reference_number AS "reference", st.notes, st.created_at AS "createdAt"
     FROM savings_transactions st WHERE st.member_id = $1 ORDER BY st.transaction_date DESC, st.id DESC LIMIT 200`,
    [memberId]
  );
  const total = await runner(`SELECT COALESCE(SUM(amount), 0) AS total FROM savings_transactions WHERE member_id = $1`, [memberId]);
  return { transactions: result.rows.map((row) => ({ ...row, amount: Number(row.amount) })), total: Number(total.rows[0].total) };
}

// Inserts one savings deposit inside the caller's transaction. Shared by the
// savings form and by OCR-posted savings forms.
export async function insertSavingsDeposit(client, req, { memberId, amountCents, date, paymentMethod, reference, notes }) {
  const member = (await client.query('SELECT id, member_number, status FROM members WHERE id = $1 FOR UPDATE', [memberId])).rows[0];
  if (!member) throw notFound('Member not found.');
  if (member.status === 'archived') throw badRequest('Savings cannot be recorded for an archived member.');
  if (reference) {
    const duplicate = await client.query('SELECT 1 FROM savings_transactions WHERE member_id = $1 AND LOWER(reference_number) = LOWER($2)', [memberId, reference]);
    if (duplicate.rows[0]) throw conflict('A savings record with this reference number already exists for this member.');
  }
  const before = (await client.query('SELECT COALESCE(SUM(amount), 0) AS total FROM savings_transactions WHERE member_id = $1', [memberId])).rows[0].total;
  const inserted = (await client.query(
    `INSERT INTO savings_transactions (member_id, transaction_type, amount, transaction_date, payment_method, reference_number, notes, recorded_by)
     VALUES ($1, 'deposit', $2::numeric, $3, $4, $5, $6, $7)
     RETURNING id, member_id AS "memberId", amount, transaction_date AS date, payment_method AS "paymentMethod", reference_number AS reference, notes, created_at AS "createdAt"`,
    [memberId, centsToString(amountCents), date, paymentMethod, reference, notes, currentUserId(req)]
  )).rows[0];
  const newTotal = centsToString(toCents(before) + amountCents);
  await createAuditLog({
    client,
    user: req.user,
    action: 'SAVINGS_DEPOSIT_CREATED',
    module: 'Savings',
    entityType: 'savings_transaction',
    entityId: String(inserted.id),
    description: `Recorded savings deposit for member ${member.member_number || memberId}`,
    oldValues: { total_savings: before },
    newValues: { member_id: memberId, amount: centsToString(amountCents), total_savings: newTotal, date, payment_method: paymentMethod, reference_number: reference },
    ...getRequestMeta(req),
  });
  await notifyMember(client, memberId, {
    type: 'savings_recorded',
    title: 'Savings deposit recorded',
    message: `A savings deposit of PHP ${Number(centsToString(amountCents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was recorded. Your total savings are PHP ${Number(newTotal).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`,
    severity: 'success',
    link: '/member-profile',
    entityType: 'savings_transaction',
    entityId: inserted.id,
    dedupeKey: `savings-${inserted.id}`,
  });
  return { record: { ...inserted, amount: Number(inserted.amount), type: 'Deposit', status: 'Completed' }, total: Number(newTotal) };
}

// POST /api/members/savings  { memberId, amount, date, paymentMethod?, reference?, notes? }
// Savings deposits are a separate ledger from share capital (no PHP 20,000 cap).
export async function createSavingsRecord(req, res) {
  const memberId = parseId(req.body?.memberId, 'member');
  const amountCents = parseMoneyInput(req.body?.amount);
  const date = cleanString(req.body?.date ?? req.body?.transactionDate, 10);
  const paymentMethod = cleanString(req.body?.paymentMethod || 'Deposit', 50);
  const reference = optionalString(req.body?.reference ?? req.body?.referenceNumber, 100);
  const notes = cleanString(req.body?.notes, 1000);
  if (amountCents === null) throw badRequest('Amount must be greater than zero with at most two decimals.');
  if (!isValidDateOnly(date)) throw badRequest('A valid date (YYYY-MM-DD) is required.');
  if (date > todayDateOnly()) throw badRequest('Savings date cannot be in the future.');
  if (!SAVINGS_METHODS.includes(paymentMethod)) throw badRequest(`Payment method must be one of: ${SAVINGS_METHODS.join(', ')}.`);

  const result = await withTransaction((client) => insertSavingsDeposit(client, req, { memberId, amountCents, date, paymentMethod, reference, notes }));
  return res.status(201).json({ success: true, data: result.record, memberTotal: result.total, message: 'Savings recorded.' });
}

export async function listSavingsRecords(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const params = [];
  const conditions = [`m.status <> 'archived'`];
  const search = cleanString(req.query.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name)) ILIKE ${p} OR m.member_number ILIKE ${p} OR st.reference_number ILIKE ${p} OR st.notes ILIKE ${p})`);
  }
  if (req.query.memberId) { params.push(parseId(req.query.memberId, 'member ID')); conditions.push(`st.member_id = $${params.length}`); }
  if (req.query.date) {
    if (!isValidDateOnly(req.query.date)) throw badRequest('date must be YYYY-MM-DD.');
    params.push(req.query.date); conditions.push(`st.transaction_date = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const from = `FROM savings_transactions st INNER JOIN members m ON m.id = st.member_id`;
  const [rows, totals] = await Promise.all([
    query(
      `SELECT st.id, st.member_id AS "memberId", TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS "memberName",
              m.member_number AS "memberNumber", st.amount, st.transaction_date AS "date", st.payment_method AS "paymentMethod",
              st.reference_number AS "reference", st.notes, st.created_at AS "createdAt"
       ${from} ${where} ORDER BY st.transaction_date DESC, st.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(st.amount), 0) AS amount, COUNT(DISTINCT st.member_id)::int AS members,
              COALESCE(SUM(st.amount) FILTER (WHERE st.transaction_date = ${SQL_TODAY}), 0) AS today,
              COALESCE(SUM(st.amount) FILTER (WHERE DATE_TRUNC('month', st.transaction_date) = DATE_TRUNC('month', ${SQL_TODAY})), 0) AS month
       ${from} ${where}`,
      params
    ),
  ]);
  const records = rows.rows.map((row) => ({
    id: Number(row.id),
    memberId: Number(row.memberId),
    memberName: row.memberName || 'Unknown Member',
    memberNumber: row.memberNumber || '—',
    date: row.date,
    amount: Number(row.amount),
    type: 'Deposit',
    paymentMethod: row.paymentMethod || 'Not specified',
    reference: row.reference || `SAV-${row.id}`,
    notes: row.notes || '',
    status: 'Completed',
    createdAt: row.createdAt,
  }));
  const t = totals.rows[0];
  return res.status(200).json({
    success: true,
    data: records,
    summary: { totalAmount: Number(t.amount), totalRecords: t.total, members: t.members, today: Number(t.today), thisMonth: Number(t.month) },
    pagination: paginationMeta(page, limit, t.total),
  });
}

async function findDuplicateMember(client, values, dateOfBirth, rsbsaNo, excludeId = null) {
  const duplicates = await client.query(
    `SELECT id, member_number FROM members
     WHERE ($4::bigint IS NULL OR id <> $4)
       AND (LOWER(email) = LOWER($1)
            OR (NULLIF(TRIM($2), '') IS NOT NULL AND LOWER(TRIM(rsbsa_no)) = LOWER(TRIM($2)))
            OR ($3::date IS NOT NULL AND date_of_birth = $3::date AND LOWER(first_name) = LOWER($5) AND LOWER(last_name) = LOWER($6)))
     LIMIT 1`,
    [values.email, rsbsaNo || '', dateOfBirth || null, excludeId, values.firstName, values.lastName]
  );
  return duplicates.rows[0] || null;
}

export function parseShareCapital(body, errors) {
  const shareCapitalCents = body.share_capital === undefined || body.share_capital === null || body.share_capital === '' ? 0 : parseMoneyInput(body.share_capital, { allowZero: true });
  if (shareCapitalCents === null) errors.push('Share capital must be a non-negative amount with up to two decimals.');
  else if (shareCapitalCents > toCents(SHARE_CAPITAL_LIMIT)) errors.push('Share capital cannot exceed the PHP 20,000 maximum limit.');
  return shareCapitalCents;
}

// Inserts one validated member inside an open transaction and assigns the next
// ACIFAC-YYYY-NNN number. The advisory lock serialises numbering across requests.
export async function insertMemberRecord(client, req, { body, values, shareCapitalCents, idDocument = null, idDocumentRef = null, photoRef = null, source = 'registration' }) {
  const duplicate = await findDuplicateMember(client, values, cleanString(body.date_of_birth, 10), cleanString(body.rsbsa_no, 100));
  if (duplicate) throw conflict(`This member appears to be already registered (${duplicate.member_number}). Check the email, RSBSA number, or name and birth date.`);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['acifac-member-number']);
  const year = todayDateOnly().slice(0, 4);
  const numberResult = await client.query(
    `SELECT COALESCE(MAX(NULLIF(SPLIT_PART(member_number, '-', 3), '')::int), 0) + 1 AS next_number
     FROM members WHERE member_number ~ $1`,
    [`^ACIFAC-${year}-[0-9]+$`]
  );
  const memberNumber = `ACIFAC-${year}-${String(numberResult.rows[0].next_number).padStart(3, '0')}`;
  const insert = await client.query(
    `INSERT INTO members (member_number, first_name, middle_name, last_name, suffix, email, phone, address,
                          barangay, municipality, province, date_of_birth, gender, civil_status, education,
                          id_type, id_number, rsbsa_no, livelihood, farm_area_ha, corn_area_ha, palay_area_ha,
                          yearly_income, spouse_name, spouse_age, spouse_contact, children, emergency_contact,
                          id_document_path, id_document_name, id_document_type, id_document_size, membership_date,
                          share_capital, status, profile_photo, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34::numeric, $35, $36, NOW())
     RETURNING id`,
    [memberNumber, values.firstName, optionalString(body.middle_name, 100), values.lastName, optionalString(body.suffix, 20), values.email,
      values.phone, values.address, optionalString(body.barangay, 150), optionalString(body.municipality, 150), optionalString(body.province, 150),
      optionalString(body.date_of_birth, 10), optionalString(body.gender, 30), optionalString(body.civil_status, 30), optionalString(body.education, 50), optionalString(body.id_type, 50),
      optionalString(body.id_number, 100), optionalString(body.rsbsa_no, 100), optionalString(body.livelihood, 255), numericOrNull(body.farm_area_ha),
      numericOrNull(body.corn_area_ha), numericOrNull(body.palay_area_ha), numericOrNull(body.yearly_income),
      optionalString(body.spouse_name, 200), numericOrNull(body.spouse_age), optionalString(body.spouse_contact, 30), optionalString(body.children, 2000),
      optionalString(body.emergency_contact, 255), idDocumentRef, idDocument ? safeOriginalName(idDocument.originalname) : null, idDocument?.mimetype ?? null, idDocument?.size ?? null,
      values.membershipDate, centsToString(shareCapitalCents), values.status, photoRef]
  );
  const id = insert.rows[0].id;
  if (shareCapitalCents > 0) {
    await client.query(
      `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, reference_number, notes, recorded_by)
       VALUES ($1, $2::numeric, $3, 'Initial', $4, 'Initial share capital recorded with member registration.', $5)`,
      [id, centsToString(shareCapitalCents), values.membershipDate, `INITIAL-${memberNumber}`, currentUserId(req)]
    );
  }
  await createAuditLog({
    client,
    user: req.user,
    action: 'MEMBER_CREATED',
    module: 'Members',
    entityType: 'member',
    entityId: String(id),
    description: source === 'import' ? `Imported member ${memberNumber}` : `Created member ${memberNumber}`,
    newValues: { member_number: memberNumber, name: `${values.firstName} ${values.lastName}`, share_capital: centsToString(shareCapitalCents), source },
    ...getRequestMeta(req),
  });
  return { id, memberNumber };
}

export async function createMember(req, res) {
  const body = req.body || {};
  const idDocument = req.files?.idDocument?.[0] || null;
  const profilePhoto = req.files?.profilePhoto?.[0] || null;
  const { errors, values } = validateMemberInput(body);
  const shareCapitalCents = parseShareCapital(body, errors);
  if (errors.length) throw badRequest(errors[0], errors);
  assertValidUpload(idDocument, DOCUMENT_TYPES, 'ID document');
  if (profilePhoto) assertValidUpload(profilePhoto, IMAGE_TYPES, 'profile photo');

  // Upload first; if the database transaction fails the files are removed again.
  const folder = `members/${todayDateOnly().slice(0, 7)}`;
  const idDocumentRef = await uploadFile({ bucket: BUCKETS.memberDocuments, folder, file: idDocument });
  const photoRef = profilePhoto ? await uploadFile({ bucket: BUCKETS.memberPhotos, folder, file: profilePhoto }) : null;

  try {
    const { id: memberId } = await withTransaction((client) => insertMemberRecord(client, req, { body, values, shareCapitalCents, idDocument, idDocumentRef, photoRef }));
    const created = await query(`${memberSelect} WHERE m.id = $1`, [memberId]);
    return res.status(201).json({ success: true, data: mapMember(created.rows[0]), message: 'Member created successfully.' });
  } catch (error) {
    await removeFile(idDocumentRef);
    if (photoRef) await removeFile(photoRef);
    throw error;
  }
}

export const MEMBER_IMPORT_MAX_ROWS = 200;

// Bulk registration from a spreadsheet parsed in the browser. Each row is saved
// on its own savepoint, so one bad row is reported without losing the others.
// ID documents are not part of an import; they can be attached later.
export async function importMembers(req, res) {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('No member rows were provided.');
  if (rows.length > MEMBER_IMPORT_MAX_ROWS) throw badRequest(`Import at most ${MEMBER_IMPORT_MAX_ROWS} members per request.`);

  const results = await withTransaction(async (client) => {
    const outcome = [];
    for (const [index, raw] of rows.entries()) {
      const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
      const rowNumber = Number.isInteger(body.row_number) ? body.row_number : index + 1;
      if (!body.membership_date) body.membership_date = todayDateOnly();
      const { errors, values } = validateMemberInput(body);
      const shareCapitalCents = parseShareCapital(body, errors);
      if (errors.length) {
        outcome.push({ row: rowNumber, success: false, errors });
        continue;
      }
      await client.query('SAVEPOINT member_import_row');
      try {
        const { id, memberNumber } = await insertMemberRecord(client, req, { body, values, shareCapitalCents, source: 'import' });
        await client.query('RELEASE SAVEPOINT member_import_row');
        outcome.push({ row: rowNumber, success: true, id: Number(id), memberNumber, name: `${values.firstName} ${values.lastName}` });
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT member_import_row');
        const message = error instanceof AppError ? error.message
          : error?.code === '23505' ? 'A member with this email already exists.'
          : error?.code?.startsWith?.('22') ? 'One of the values has an invalid format.'
          : null;
        if (!message) throw error;
        outcome.push({ row: rowNumber, success: false, errors: [message] });
      }
    }
    return outcome;
  });

  const imported = results.filter((row) => row.success).length;
  // Always 200: a partly failed import is a normal outcome reported per row.
  return res.status(200).json({
    success: true,
    message: `${imported} of ${rows.length} member(s) imported.`,
    data: { imported, failed: rows.length - imported, results },
  });
}

export async function updateMember(req, res) {
  const id = parseId(req.params.id, 'member ID');
  const body = req.body || {};
  const { errors, values } = validateMemberInput(body);
  if (errors.length) throw badRequest(errors[0], errors);

  const updated = await withTransaction(async (client) => {
    const before = (await client.query(`${memberSelect} WHERE m.id = $1 FOR UPDATE OF m`, [id])).rows[0];
    if (!before) throw notFound('Member not found.');
    if (before.status === 'archived') throw badRequest('Restore this member before editing.');
    const duplicate = await findDuplicateMember(client, values, cleanString(body.date_of_birth, 10), cleanString(body.rsbsa_no, 100), id);
    if (duplicate) throw conflict(`Another member (${duplicate.member_number}) already uses this email, RSBSA number, or name and birth date.`);
    await client.query(
      `UPDATE members SET first_name = $1, middle_name = $2, last_name = $3, suffix = $4, email = $5, phone = $6,
                          address = $7, barangay = $8, municipality = $9, province = $10, date_of_birth = $11,
                          gender = $12, civil_status = $13, education = $14, id_type = $15, id_number = $16,
                          rsbsa_no = $17, livelihood = $18, farm_area_ha = $19, corn_area_ha = $20,
                          palay_area_ha = $21, yearly_income = $22, spouse_name = $23, spouse_age = $24,
                          spouse_contact = $25, children = $26, emergency_contact = $27, membership_date = $28,
                          share_capital = COALESCE((SELECT SUM(amount) FROM share_contributions WHERE member_id = $30), 0),
                          status = $29, updated_at = NOW()
       WHERE id = $30`,
      [values.firstName, optionalString(body.middle_name, 100), values.lastName, optionalString(body.suffix, 20), values.email, values.phone,
        values.address, optionalString(body.barangay, 150), optionalString(body.municipality, 150), optionalString(body.province, 150), optionalString(body.date_of_birth, 10),
        optionalString(body.gender, 30), optionalString(body.civil_status, 30), optionalString(body.education, 50), optionalString(body.id_type, 50), optionalString(body.id_number, 100),
        optionalString(body.rsbsa_no, 100), optionalString(body.livelihood, 255), numericOrNull(body.farm_area_ha), numericOrNull(body.corn_area_ha),
        numericOrNull(body.palay_area_ha), numericOrNull(body.yearly_income), optionalString(body.spouse_name, 200), numericOrNull(body.spouse_age),
        optionalString(body.spouse_contact, 30), optionalString(body.children, 2000), optionalString(body.emergency_contact, 255), values.membershipDate,
        values.status, id]
    );
    const after = (await client.query(`${memberSelect} WHERE m.id = $1`, [id])).rows[0];
    await createAuditLog({ client, user: req.user, action: 'MEMBER_UPDATED', module: 'Members', entityType: 'member', entityId: String(id), description: `Updated member ${after.member_number}`, oldValues: before, newValues: after, ...getRequestMeta(req) });
    return after;
  });
  return res.status(200).json({ success: true, data: mapMember(updated), message: 'Member updated successfully.' });
}

async function changeArchiveState(req, res, archive) {
  const id = parseId(req.params.id, 'member ID');
  const member = await withTransaction(async (client) => {
    const before = (await client.query(`SELECT id, member_number, status, archived_at FROM members WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) throw notFound('Member not found.');
    if (archive && before.status === 'archived') throw conflict('Member is already archived.');
    if (!archive && before.status !== 'archived') throw conflict('Member is not archived.');
    const result = archive
      ? await client.query(`UPDATE members SET status = 'archived', archived_at = NOW(), archived_by = $1, updated_at = NOW() WHERE id = $2 RETURNING id, member_number, status, archived_at, archived_by`, [currentUserId(req), id])
      : await client.query(`UPDATE members SET status = 'active', archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $1 RETURNING id, member_number, status`, [id]);
    const row = result.rows[0];
    await createAuditLog({
      client,
      user: req.user,
      action: archive ? 'MEMBER_ARCHIVED' : 'MEMBER_RESTORED',
      module: 'Members',
      entityType: 'member',
      entityId: String(id),
      description: `${archive ? 'Archived' : 'Restored'} member ${row.member_number}`,
      oldValues: { status: before.status, archived_at: before.archived_at },
      newValues: { status: row.status, archived_at: row.archived_at ?? null, archived_by: row.archived_by ?? null },
      ...getRequestMeta(req),
    });
    return row;
  });
  return res.status(200).json({ success: true, message: archive ? 'Member archived successfully.' : 'Member restored successfully.', data: member });
}

export const archiveMember = (req, res) => changeArchiveState(req, res, true);
export const restoreMember = (req, res) => changeArchiveState(req, res, false);
