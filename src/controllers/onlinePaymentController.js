import crypto from 'node:crypto';
import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { formatDateOnly, isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, forbidden, getRequestMeta, currentUserId, notFound, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { displayName } from '../utils/people.js';
import { normalizePhilippineMobile } from '../utils/phone.js';
import { notifyAdmins, notifyMember } from '../services/notificationService.js';
import { emailMember } from '../services/memberEmails.js';
import { onlinePaymentRejectedEmail, savingsDepositEmail } from '../services/emailTemplates.js';
import { aiFailureReason, askAi } from '../services/aiClient.js';
import { assertValidUpload, BUCKETS, downloadFile, removeFile, sendStoredFile, uploadFile } from '../services/storage.js';
import { IMAGE_TYPES } from '../middleware/upload.js';
import {
  normalizeProofReading, normalizeReference, PAYMENT_CHANNELS, PROOF_INSTRUCTION, PROOF_PROMPT, proofFlags,
} from '../services/paymentProof.js';
import { emailLoanPayment, insertLoanPayment, unpaidLoansOf } from './loanController.js';
import { insertDuesPayment } from './duesController.js';
import { insertSavingsDeposit } from './memberController.js';

// Pay online: a member pays a loan, dues or a savings deposit by GCash or Maya
// into the cooperative's account, then reports it here with the screenshot and
// reference number. AI reads the screenshot and the problems it shows are
// flagged; the office (the treasurer) checks the cooperative's own GCash or
// Maya app and approves, which records the payment as the office records any
// payment (method GCash or Maya, with the reference number), or rejects it
// with the reason the member is told.

const MODULE = 'Online Payments';
const PURPOSES = ['loan', 'dues', 'savings'];
// The most a member may deposit to savings in one online payment.
const MAX_SAVINGS_CENTS = 10000000;
const MEMBER_NAME = `TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix))`;
const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const channelOf = (value) => PAYMENT_CHANNELS.find((channel) => channel.toLowerCase() === String(value ?? '').trim().toLowerCase()) ?? null;

const submissionSelect = `
  SELECT s.id, s.member_id AS "memberId", m.member_number AS "memberNumber", ${MEMBER_NAME} AS "memberName",
         s.purpose, s.loan_id AS "loanId", l.loan_number AS "loanNumber", s.due_ids AS "dueIds",
         (SELECT COALESCE(json_agg(json_build_object('id', d.id, 'kind', d.kind, 'amount', d.amount, 'dueDate', d.due_date,
                                                     'description', COALESCE(a.title, NULLIF(d.description, ''), d.kind)) ORDER BY d.due_date, d.id), '[]'::json)
          FROM member_dues d LEFT JOIN activities a ON a.id = d.activity_id WHERE d.id = ANY(s.due_ids)) AS dues,
         s.amount, s.channel, s.reference_number AS reference, s.paid_on AS "paidOn", s.proof_mime_type AS "proofMimeType",
         s.ai_reading AS reading, s.flags, s.status, ${displayName('r')} AS "reviewedBy", r.position AS "reviewedByPosition",
         s.reviewed_at AS "reviewedAt", s.review_notes AS "reviewNotes", s.created_at AS "createdAt",
         s.loan_payment_id AS "loanPaymentId", s.dues_payment_id AS "duesPaymentId", s.savings_transaction_id AS "savingsTransactionId"
  FROM payment_submissions s
  JOIN members m ON m.id = s.member_id
  LEFT JOIN loans l ON l.id = s.loan_id
  LEFT JOIN users r ON r.id = s.reviewed_by`;

const asSubmission = (row) => ({ ...row, amount: Number(row.amount), dues: (row.dues ?? []).map((due) => ({ ...due, amount: Number(due.amount) })) });
// What a member sees of their own submissions: not what AI read or flagged (that is the office's).
const forMember = ({ reading: _reading, flags: _flags, memberNumber: _memberNumber, ...row }) => row;

/** "loan L-2026-001", "3 dues", "a savings deposit" */
function purposeText(row) {
  if (row.purpose === 'loan') return `loan ${row.loanNumber ?? row.loan_number ?? ''}`.trim();
  if (row.purpose === 'dues') {
    const count = row.dueIds?.length ?? row.due_ids?.length ?? 0;
    return `${count} ${count === 1 ? 'due' : 'dues'}`;
  }
  return 'a savings deposit';
}

// ----- The cooperative's accounts (Settings) ---------------------------------------

const channelSelect = `
  SELECT c.channel, c.account_name AS "accountName", c.account_number AS "accountNumber", c.enabled,
         c.qr_reference IS NOT NULL AS "hasQr", c.updated_at AS "updatedAt", ${displayName('u')} AS "updatedBy"
  FROM payment_channels c LEFT JOIN users u ON u.id = c.updated_by`;

async function enabledChannels() {
  return (await query(`${channelSelect} WHERE c.enabled ORDER BY c.channel`)).rows.map(({ updatedBy: _by, updatedAt: _at, ...channel }) => channel);
}

// GET /api/payment-channels: the office sees both accounts; a member only the ones that take payments.
export async function listPaymentChannels(req, res) {
  if (req.user.role !== 'ADMIN') return res.json({ success: true, data: await enabledChannels() });
  return res.json({ success: true, data: (await query(`${channelSelect} ORDER BY c.channel`)).rows });
}

// GET /api/payment-channels/:channel/qr: the account's QR code picture.
export async function getPaymentChannelQr(req, res) {
  const channel = channelOf(req.params.channel);
  if (!channel) throw notFound('Unknown payment channel.');
  const row = (await query('SELECT qr_reference, qr_mime_type, enabled FROM payment_channels WHERE channel = $1', [channel])).rows[0];
  if (!row?.qr_reference || (req.user.role !== 'ADMIN' && !row.enabled)) throw notFound(`No ${channel} QR code was uploaded.`);
  const sent = await sendStoredFile(res, { reference: row.qr_reference, mimeType: row.qr_mime_type, fileName: `${channel}-qr` });
  if (!sent) throw notFound(`No ${channel} QR code was uploaded.`);
  return undefined;
}

// PUT /api/payment-channels/:channel (multipart: qr?, accountName, accountNumber, enabled)
export async function updatePaymentChannel(req, res) {
  const channel = channelOf(req.params.channel);
  if (!channel) throw notFound('Unknown payment channel.');
  const accountName = cleanString(req.body?.accountName, 150);
  const numberText = cleanString(req.body?.accountNumber, 30);
  const mobile = numberText ? normalizePhilippineMobile(numberText) : null;
  if (numberText && !mobile) throw badRequest(`Enter the ${channel} account's mobile number, e.g. 0917 123 4567.`);
  const accountNumber = mobile ? `0${mobile.slice(3)}` : '';
  const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
  if (enabled && (!accountName || !accountNumber)) throw badRequest(`Enter the ${channel} account name and number before members can pay by ${channel}.`);
  if (req.file) assertValidUpload(req.file, IMAGE_TYPES, 'QR code');

  const qrReference = req.file ? await uploadFile({ bucket: BUCKETS.memberDocuments, folder: 'payment-channels', file: req.file }) : null;
  let previousQr = null;
  try {
    await withTransaction(async (client) => {
      const before = (await client.query('SELECT * FROM payment_channels WHERE channel = $1 FOR UPDATE', [channel])).rows[0];
      if (!before) throw notFound('Unknown payment channel.');
      if (enabled && !qrReference && !before.qr_reference) throw badRequest(`Upload the ${channel} QR code before members can pay by ${channel}.`);
      previousQr = qrReference ? before.qr_reference : null;
      await client.query(
        `UPDATE payment_channels SET account_name = $2, account_number = $3, enabled = $4,
                qr_reference = COALESCE($5, qr_reference), qr_mime_type = CASE WHEN $5::text IS NULL THEN qr_mime_type ELSE $6 END,
                updated_by = $7, updated_at = NOW()
         WHERE channel = $1`,
        [channel, accountName, accountNumber, enabled, qrReference, req.file?.mimetype ?? null, currentUserId(req)]
      );
      await createAuditLog({
        client, user: req.user, action: 'PAYMENT_CHANNEL_UPDATED', module: MODULE, entityType: 'payment_channel', entityId: channel,
        description: `Updated the cooperative's ${channel} account${enabled ? '' : ' (members cannot pay by it)'}`,
        oldValues: { account_name: before.account_name, account_number: before.account_number, enabled: before.enabled },
        newValues: { account_name: accountName, account_number: accountNumber, enabled, ...(qrReference ? { qr_code: 'replaced' } : {}) },
        ...getRequestMeta(req),
      });
    });
  } catch (error) {
    if (qrReference) await removeFile(qrReference);
    throw error;
  }
  if (previousQr) await removeFile(previousQr);
  const data = (await query(`${channelSelect} WHERE c.channel = $1`, [channel])).rows[0];
  return res.json({ success: true, data, message: `${channel} account saved.` });
}

// ----- Members: what can be paid, and reporting a payment ---------------------------

// The member's unpaid dues not already in a payment waiting for the office.
async function payableDues(memberId) {
  return (await query(
    `SELECT d.id, d.kind, d.amount, d.due_date AS "dueDate", COALESCE(a.title, NULLIF(d.description, ''), d.kind) AS description
     FROM member_dues d LEFT JOIN activities a ON a.id = d.activity_id
     WHERE d.member_id = $1 AND d.payment_id IS NULL AND d.waived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM payment_submissions s WHERE s.member_id = d.member_id AND s.status = 'pending' AND d.id = ANY(s.due_ids))
     ORDER BY d.due_date, d.id`,
    [memberId]
  )).rows.map((due) => ({ ...due, amount: Number(due.amount) }));
}

// The member's loans with a balance, less what payments waiting for the office already cover.
async function payableLoans(memberId) {
  const pending = (await query(
    `SELECT loan_id, COALESCE(SUM(amount), 0) AS amount FROM payment_submissions WHERE member_id = $1 AND purpose = 'loan' AND status = 'pending' GROUP BY loan_id`,
    [memberId]
  )).rows;
  return (await unpaidLoansOf(memberId)).map((loan) => {
    const pendingCents = toCents(pending.find((row) => Number(row.loan_id) === loan.id)?.amount ?? 0);
    return { ...loan, pendingAmount: Number(centsToString(pendingCents)), payableNow: Number(centsToString(Math.max(0, toCents(loan.amountDueNow) - pendingCents))) };
  });
}

// GET /api/payment-submissions/me: the member's reported payments, what they can pay, and the cooperative's accounts.
export async function getMyOnlinePayments(req, res) {
  const memberId = Number(req.user.member_id);
  const [submissions, loans, dues, channels] = await Promise.all([
    query(`${submissionSelect} WHERE s.member_id = $1 ORDER BY s.created_at DESC, s.id DESC LIMIT 100`, [memberId]),
    payableLoans(memberId),
    payableDues(memberId),
    enabledChannels(),
  ]);
  return res.json({ success: true, submissions: submissions.rows.map(asSubmission).map(forMember), payable: { loans, dues }, channels });
}

function readDueIds(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
  const ids = [...new Set(raw.map((id) => String(id).trim()).filter(Boolean).map(Number))];
  if (!ids.length) throw badRequest('Choose the dues you paid.');
  if (ids.length > 200 || ids.some((id) => !Number.isInteger(id) || id <= 0)) throw badRequest('Some of the dues chosen are not valid.');
  return ids;
}

// What AI read and the problems found, for a submission (or one being made).
async function checkProof(file, { submissionId = null, amountCents, referenceNumber, paidOn, channel, proofSha, createdOn }) {
  let reading;
  try {
    reading = normalizeProofReading(await askAi(file, PROOF_PROMPT, PROOF_INSTRUCTION));
  } catch (error) {
    console.error('Payment screenshot reading error:', error instanceof Error ? error.message : error);
    reading = { error: aiFailureReason(error) };
  }
  const [account, same, rejected, recorded] = await Promise.all([
    query('SELECT account_number AS "accountNumber", account_name AS "accountName" FROM payment_channels WHERE channel = $1', [channel]),
    query(`SELECT id, status FROM payment_submissions WHERE proof_sha256 = $1 AND ($2::int IS NULL OR id <> $2) ORDER BY id`, [proofSha, submissionId]),
    query(`SELECT id, review_notes AS "reviewNotes" FROM payment_submissions WHERE channel = $1 AND reference_number = $2 AND status = 'rejected' AND ($3::int IS NULL OR id <> $3) ORDER BY id`, [channel, referenceNumber, submissionId]),
    referenceOnRecords(referenceNumber),
  ]);
  const flags = proofFlags({
    reading, submission: { amountCents, referenceNumber, paidOn, channel }, account: account.rows[0], today: createdOn,
    sameScreenshot: same.rows, rejectedBefore: rejected.rows, referenceRecorded: recorded,
  });
  return { reading, flags };
}

// Where the reference number is already on the cooperative's records (payments
// the office recorded, or online payments approved before). A dues payment's own
// share contribution and savings deposit carry its reference too, so they are
// counted as that one dues payment.
async function referenceOnRecords(referenceNumber) {
  const same = (column) => `UPPER(regexp_replace(COALESCE(${column}, ''), '[^A-Za-z0-9]', '', 'g')) = $1`;
  const rows = (await query(
    `SELECT 'a loan payment (' || l.loan_number || ')' AS place FROM loan_payments p JOIN loans l ON l.id = p.loan_id WHERE ${same('p.reference_number')}
     UNION ALL SELECT 'a dues payment' FROM member_dues_payments p WHERE ${same('p.reference_number')}
     UNION ALL SELECT 'a savings record' FROM savings_transactions t WHERE ${same('t.reference_number')}
       AND NOT EXISTS (SELECT 1 FROM member_dues_payments p WHERE p.savings_transaction_id = t.id)
     UNION ALL SELECT 'a share capital contribution' FROM share_contributions c WHERE ${same('c.reference_number')}
       AND NOT EXISTS (SELECT 1 FROM member_dues_payments p WHERE p.share_contribution_id = c.id)
     LIMIT 5`,
    [referenceNumber]
  )).rows;
  return [...new Set(rows.map((row) => row.place))];
}

// POST /api/payment-submissions (multipart: proof, purpose, loanId? | dueIds? | amount, channel, referenceNumber, paidOn)
export async function submitOnlinePayment(req, res) {
  const memberId = Number(req.user.member_id);
  const body = req.body ?? {};
  const purpose = cleanString(body.purpose, 10);
  if (!PURPOSES.includes(purpose)) throw badRequest('Choose what the payment is for: your loan, your dues or a savings deposit.');
  const channel = channelOf(body.channel);
  if (!channel) throw badRequest('Choose GCash or Maya.');
  const referenceNumber = normalizeReference(body.referenceNumber);
  if (referenceNumber.length < 6 || referenceNumber.length > 40) throw badRequest(`Enter the reference number shown on the ${channel} payment (letters and digits, at least 6).`);
  const paidOn = cleanString(body.paidOn, 10);
  const today = todayDateOnly();
  if (!isValidDateOnly(paidOn)) throw badRequest('Enter the date you paid.');
  if (paidOn > today) throw badRequest('The date you paid cannot be in the future.');
  const file = req.file;
  assertValidUpload(file, IMAGE_TYPES, 'screenshot of the payment');

  const account = (await query('SELECT enabled FROM payment_channels WHERE channel = $1', [channel])).rows[0];
  if (!account?.enabled) throw badRequest(`The cooperative does not take ${channel} payments right now. Please pay at the office.`);
  const member = (await query(`SELECT m.id, m.member_number, m.status, ${MEMBER_NAME} AS name FROM members m WHERE m.id = $1`, [memberId])).rows[0];
  if (!member || member.status === 'archived') throw forbidden('Your membership is terminated, so payments cannot be made online.');

  let amountCents;
  let loanId = null;
  let dueIds = [];
  let target = '';
  if (purpose === 'loan') {
    loanId = parseId(body.loanId, 'loan');
    amountCents = parseMoneyInput(body.amount);
    if (amountCents === null) throw badRequest('Enter the amount you sent, greater than zero with at most two decimals.');
    const loan = (await payableLoans(memberId)).find((row) => row.id === loanId);
    if (!loan) throw badRequest('This is not one of your loans with a balance to pay.');
    if (paidOn < loan.dateApproved) throw badRequest(`The date you paid cannot be before the loan was approved (${formatDateOnly(loan.dateApproved)}).`);
    if (amountCents > toCents(loan.payableNow)) {
      throw badRequest(loan.pendingAmount > 0
        ? `You owe ${pesos(toCents(loan.amountDueNow))} on loan ${loan.loanNumber}, and ${pesos(toCents(loan.pendingAmount))} of it is in a payment the office is still checking: at most ${pesos(toCents(loan.payableNow))} more can be paid.`
        : `You owe ${pesos(toCents(loan.amountDueNow))} on loan ${loan.loanNumber}: the payment cannot be more than that.`);
    }
    target = `loan ${loan.loanNumber}`;
  } else if (purpose === 'dues') {
    dueIds = readDueIds(body.dueIds);
    const open = await payableDues(memberId);
    const chosen = open.filter((due) => dueIds.includes(due.id));
    if (chosen.length !== dueIds.length) throw badRequest('Some of the dues chosen are already paid, waived or in a payment the office is still checking. Refresh the page and choose again.');
    const latest = chosen.reduce((max, due) => (due.dueDate > max ? due.dueDate : max), chosen[0].dueDate);
    if (paidOn < latest) throw badRequest(`The date you paid cannot be before ${formatDateOnly(latest)}, the date of the latest due you are paying.`);
    amountCents = chosen.reduce((sum, due) => sum + toCents(due.amount), 0);
    target = `${chosen.length} ${chosen.length === 1 ? 'due' : 'dues'}`;
  } else {
    amountCents = parseMoneyInput(body.amount);
    if (amountCents === null) throw badRequest('Enter the amount you sent, greater than zero with at most two decimals.');
    if (amountCents > MAX_SAVINGS_CENTS) throw badRequest(`An online savings deposit can be at most ${pesos(MAX_SAVINGS_CENTS)}. For more, please deposit at the office.`);
    target = 'a savings deposit';
  }

  const used = (await query(`SELECT id, status FROM payment_submissions WHERE channel = $1 AND reference_number = $2 AND status <> 'rejected' LIMIT 1`, [channel, referenceNumber])).rows[0];
  if (used) throw conflict(`A ${channel} payment with reference number ${referenceNumber} was already reported (${used.status === 'approved' ? 'and recorded' : 'the office is checking it'}). Each payment can be reported once.`);

  const proofSha = sha256(file.buffer);
  const { reading, flags } = await checkProof(file, { amountCents, referenceNumber, paidOn, channel, proofSha, createdOn: today });
  const proofReference = await uploadFile({ bucket: BUCKETS.memberDocuments, folder: `payment-proofs/${memberId}`, file });
  let id;
  try {
    id = await withTransaction(async (client) => {
      const inserted = (await client.query(
        `INSERT INTO payment_submissions (member_id, submitted_by, purpose, loan_id, due_ids, amount, channel, reference_number, paid_on,
                                          proof_reference, proof_mime_type, proof_sha256, ai_reading, flags)
         VALUES ($1, $2, $3, $4, $5::int[], $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [memberId, currentUserId(req), purpose, loanId, dueIds, centsToString(amountCents), channel, referenceNumber, paidOn,
          proofReference, file.mimetype, proofSha, JSON.stringify(reading), JSON.stringify(flags)]
      )).rows[0].id;
      await createAuditLog({
        client, user: req.user, action: 'ONLINE_PAYMENT_SUBMITTED', module: MODULE, entityType: 'payment_submission', entityId: String(inserted),
        description: `Reported a ${channel} payment of ${pesos(amountCents)} for ${target}`,
        newValues: { member_id: memberId, purpose, loan_id: loanId, due_ids: dueIds, amount: centsToString(amountCents), channel, reference_number: referenceNumber, paid_on: paidOn, flags: flags.map((flag) => flag.code) },
        ...getRequestMeta(req),
      });
      const problems = flags.filter((flag) => flag.severity === 'error').length;
      await notifyAdmins(client, {
        type: 'online_payment_submitted', title: `${channel} payment to check`,
        message: `${member.name} reported a ${channel} payment of ${pesos(amountCents)} for ${target} (reference ${referenceNumber}).${problems ? ` ${problems} ${problems === 1 ? 'problem was' : 'problems were'} found on the screenshot.` : ''} Check the cooperative's ${channel} app before approving.`,
        severity: problems ? 'warning' : 'info', link: '/admin/online-payments', entityType: 'payment_submission', entityId: inserted, dedupeKey: `online-payment-${inserted}`,
      });
      return inserted;
    });
  } catch (error) {
    await removeFile(proofReference);
    if (error?.code === '23505') throw conflict(`A ${channel} payment with reference number ${referenceNumber} was already reported. Each payment can be reported once.`);
    throw error;
  }
  const row = (await query(`${submissionSelect} WHERE s.id = $1`, [id])).rows[0];
  return res.status(201).json({ success: true, data: forMember(asSubmission(row)), message: 'Payment sent to the office. It is recorded once the office confirms the money arrived.' });
}

// GET /api/payment-submissions/:id/proof: the screenshot (the office, or the member who sent it).
export async function getPaymentProof(req, res) {
  const id = parseId(req.params.id, 'payment');
  const row = (await query('SELECT member_id, proof_reference, proof_mime_type FROM payment_submissions WHERE id = $1', [id])).rows[0];
  if (!row || (req.user.role !== 'ADMIN' && Number(row.member_id) !== Number(req.user.member_id))) throw notFound('Payment not found.');
  const sent = await sendStoredFile(res, { reference: row.proof_reference, mimeType: row.proof_mime_type, fileName: `payment-${id}` });
  if (!sent) throw notFound('The screenshot could not be found.');
  return undefined;
}

// ----- The office: the queue, approve, reject ---------------------------------------

// GET /api/payment-submissions?status=pending|approved|rejected|all&page=&limit=
// Waiting ones oldest first (the order they came in), the rest newest first.
export async function listOnlinePayments(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const status = cleanString(req.query.status, 10) || 'pending';
  if (!['pending', 'approved', 'rejected', 'all'].includes(status)) throw badRequest('Status must be pending, approved, rejected or all.');
  const where = status === 'all' ? '' : 'WHERE s.status = $3';
  const params = status === 'all' ? [limit, offset] : [limit, offset, status];
  const order = status === 'pending' ? 's.created_at, s.id' : 's.created_at DESC, s.id DESC';
  const [rows, counts] = await Promise.all([
    query(`${submissionSelect} ${where} ORDER BY ${order} LIMIT $1 OFFSET $2`, params),
    query(`SELECT status, COUNT(*)::int AS count FROM payment_submissions GROUP BY status`),
  ]);
  const totals = Object.fromEntries(['pending', 'approved', 'rejected'].map((key) => [key, counts.rows.find((row) => row.status === key)?.count ?? 0]));
  const total = status === 'all' ? totals.pending + totals.approved + totals.rejected : totals[status];
  return res.json({ success: true, data: rows.rows.map(asSubmission), counts: totals, pagination: paginationMeta(page, limit, total) });
}

async function lockPending(client, id) {
  const row = (await client.query(
    `SELECT s.*, l.loan_number, ${MEMBER_NAME} AS member_name FROM payment_submissions s JOIN members m ON m.id = s.member_id LEFT JOIN loans l ON l.id = s.loan_id WHERE s.id = $1 FOR UPDATE OF s`,
    [id]
  )).rows[0];
  if (!row) throw notFound('Payment not found.');
  if (row.status !== 'pending') throw conflict(`This payment was already ${row.status}.`);
  return row;
}

// POST /api/payment-submissions/:id/approve { confirmed: true, notes? }
// Only after the treasurer saw the money in the cooperative's GCash or Maya app
// (`confirmed`). Records the payment as the office records any payment.
export async function approveOnlinePayment(req, res) {
  const id = parseId(req.params.id, 'payment');
  if (req.body?.confirmed !== true) throw badRequest('Check the cooperative\'s GCash or Maya app first, and approve only when the money arrived there.');
  const notes = cleanString(req.body?.notes, 500);
  const after = await withTransaction(async (client) => {
    const row = await lockPending(client, id);
    const amountCents = toCents(row.amount);
    const method = { paymentMethod: row.channel, reference: row.reference_number };
    const links = { loan: null, dues: null, savings: null };
    let followUp = null;
    if (row.purpose === 'loan') {
      const payment = await insertLoanPayment(client, req, { loanId: row.loan_id, amountCents, paymentDate: row.paid_on, ...method });
      links.loan = payment.id;
      followUp = () => emailLoanPayment(row.loan_id, payment);
    } else if (row.purpose === 'dues') {
      links.dues = (await insertDuesPayment(client, req, { memberId: row.member_id, dueIds: row.due_ids, paymentDate: row.paid_on, ...method, notes: `Paid online by ${row.channel}, reference ${row.reference_number}.` })).id;
    } else {
      const result = await insertSavingsDeposit(client, req, {
        memberId: row.member_id, amountCents, date: row.paid_on, paymentMethod: row.channel, reference: row.reference_number, notes: `Deposited online by ${row.channel} (online payment #${id}).`,
      });
      links.savings = result.record.id;
      followUp = () => emailMember(row.member_id, (recipient) => savingsDepositEmail({ memberName: recipient.full_name, amount: result.record.amount, date: row.paid_on, reference: row.reference_number, total: result.total }));
    }
    await client.query(
      `UPDATE payment_submissions SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), review_notes = NULLIF($3, ''),
              loan_payment_id = $4, dues_payment_id = $5, savings_transaction_id = $6, updated_at = NOW() WHERE id = $1`,
      [id, currentUserId(req), notes, links.loan, links.dues, links.savings]
    );
    await createAuditLog({
      client, user: req.user, action: 'ONLINE_PAYMENT_APPROVED', module: MODULE, entityType: 'payment_submission', entityId: String(id),
      description: `Approved the ${row.channel} payment of ${pesos(amountCents)} from ${row.member_name} for ${purposeText(row)} (reference ${row.reference_number})`,
      oldValues: { status: 'pending' },
      // The money it brought in is in the audit entry of the payment it recorded (capital_change there).
      newValues: { status: 'approved', confirmed_in_app: true, notes: notes || null, loan_payment_id: links.loan, dues_payment_id: links.dues, savings_transaction_id: links.savings },
      ...getRequestMeta(req),
    });
    return followUp;
  });
  if (after) await after();
  const row = (await query(`${submissionSelect} WHERE s.id = $1`, [id])).rows[0];
  return res.json({ success: true, data: asSubmission(row), message: 'Payment approved and recorded.' });
}

// POST /api/payment-submissions/:id/reject { reason }: the member is told why.
export async function rejectOnlinePayment(req, res) {
  const id = parseId(req.params.id, 'payment');
  const reason = cleanString(req.body?.reason, 500);
  if (reason.length < 3) throw badRequest('Give the reason, so the member knows what to do.');
  const row = await withTransaction(async (client) => {
    const pending = await lockPending(client, id);
    await client.query(`UPDATE payment_submissions SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_notes = $3, updated_at = NOW() WHERE id = $1`, [id, currentUserId(req), reason]);
    await createAuditLog({
      client, user: req.user, action: 'ONLINE_PAYMENT_REJECTED', module: MODULE, entityType: 'payment_submission', entityId: String(id),
      description: `Rejected the ${pending.channel} payment of ${pesos(toCents(pending.amount))} from ${pending.member_name} for ${purposeText(pending)} (reference ${pending.reference_number})`,
      oldValues: { status: 'pending' }, newValues: { status: 'rejected', reason }, ...getRequestMeta(req),
    });
    await notifyMember(client, pending.member_id, {
      type: 'online_payment_rejected', title: `${pending.channel} payment not accepted`, severity: 'error', link: '/member/pay-online',
      message: `Your ${pending.channel} payment of ${pesos(toCents(pending.amount))} for ${purposeText(pending)} (reference ${pending.reference_number}) was not accepted: ${reason}`,
      entityType: 'payment_submission', entityId: id, dedupeKey: `online-payment-rejected-${id}`,
    });
    return pending;
  });
  void emailMember(row.member_id, (recipient) => onlinePaymentRejectedEmail({
    memberName: recipient.full_name, channel: row.channel, amount: row.amount, reference: row.reference_number, paidOn: row.paid_on, purpose: purposeText(row), reason,
  }));
  const updated = (await query(`${submissionSelect} WHERE s.id = $1`, [id])).rows[0];
  return res.json({ success: true, data: asSubmission(updated), message: 'Payment rejected. The member was told why.' });
}

// POST /api/payment-submissions/:id/read-again: AI reads a waiting payment's screenshot again (e.g. it was busy).
export async function readOnlinePaymentAgain(req, res) {
  const id = parseId(req.params.id, 'payment');
  const row = (await query('SELECT * FROM payment_submissions WHERE id = $1', [id])).rows[0];
  if (!row) throw notFound('Payment not found.');
  if (row.status !== 'pending') throw conflict(`This payment was already ${row.status}.`);
  const buffer = await downloadFile(row.proof_reference);
  if (!buffer) throw notFound('The screenshot could not be found.');
  const { reading, flags } = await checkProof({ buffer, mimetype: row.proof_mime_type, originalname: `payment-${id}` }, {
    submissionId: id, amountCents: toCents(row.amount), referenceNumber: row.reference_number, paidOn: row.paid_on, channel: row.channel,
    proofSha: row.proof_sha256, createdOn: formatCreatedOn(row.created_at),
  });
  await query(`UPDATE payment_submissions SET ai_reading = $2, flags = $3, updated_at = NOW() WHERE id = $1 AND status = 'pending'`, [id, JSON.stringify(reading), JSON.stringify(flags)]);
  const updated = (await query(`${submissionSelect} WHERE s.id = $1`, [id])).rows[0];
  return res.json({ success: true, data: asSubmission(updated), message: reading.error ? `AI could not read it (${reading.error}).` : 'Screenshot read again.' });
}

// The Manila date a submission was made (YYYY-MM-DD), for "more than 7 days before it was reported".
const formatCreatedOn = (createdAt) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(createdAt));
