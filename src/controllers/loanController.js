import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { createAuditLog } from '../utils/audit.js';
import { isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, optionalString, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { sendEmailSafely } from '../services/emailService.js';
import { loanDecisionEmail, loanSubmittedEmail, paymentEmail } from '../services/emailTemplates.js';
import { notifyAdmins, notifyMember } from '../services/notificationService.js';
import {
  allocatePayment, calculateLoanFinancials, createInstallments, ensureInstallments, LOAN_POLICY, recomputeLoanState, refreshLoanStatusesInBackground,
} from '../services/loanService.js';

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const AREA_PATTERN = /^\d+(\.\d{1,2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;
const LOAN_TYPES = ['agricultural', 'personal', 'emergency'];

// Every money value the API returns for a loan comes from these columns, so the
// admin page, member page, receipts and analytics always agree.
const loanSelect = `
  SELECT l.id AS "databaseId", l.loan_number AS id, l.member_id AS "memberDatabaseId",
         COALESCE(m.member_number, l.member_number, l.member_id::text) AS "memberId", l.member_name AS "memberName",
         l.loan_type AS "loanType", l.amount,
         COALESCE(l.total_repayment, ROUND(l.amount + ROUND(l.amount * l.interest_rate / 100, 2), 2)) AS "totalAmount",
         COALESCE(l.calculated_interest, ROUND(l.amount * l.interest_rate / 100, 2)) AS "totalInterest",
         l.balance, l.interest_rate AS "interestRate", l.term, l.status, l.date_approved AS "dateApproved", l.due_date AS "dueDate",
         l.next_payment_date AS "nextPaymentDate", l.monthly_payment AS "monthlyPayment",
         COALESCE(pay.total_paid, 0) AS "totalPaid", COALESCE(pay.payment_count, 0)::int AS "paymentCount",
         COALESCE(inst.overdue_amount, 0) AS "overdueAmount", COALESCE(inst.overdue_installments, 0)::int AS "overdueInstallments",
         COALESCE(inst.paid_installments, 0)::int AS "paidInstallments", inst.next_amount_due AS "nextAmountDue",
         l.farm_area AS "farmArea", l.maximum_eligible_amount AS "maximumEligibleAmount",
         l.purpose, l.loan_mode AS "loanMode", l.co_maker_name AS "coMakerName",
         l.co_maker_address AS "coMakerAddress", l.co_maker_contact AS "coMakerContact",
         l.co_maker_relationship AS "coMakerRelationship", l.collateral_type AS "collateralType",
         l.collateral_details AS "collateralDetails", l.in_kind_items AS "inKindItems", l.loan_request_id AS "loanRequestId"
  FROM loans l
  LEFT JOIN members m ON m.id = l.member_id
  LEFT JOIN LATERAL (SELECT SUM(p.amount) AS total_paid, COUNT(*) AS payment_count FROM loan_payments p WHERE p.loan_id = l.id) pay ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(i.amount_due - i.amount_paid) FILTER (WHERE i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}) AS overdue_amount,
           COUNT(*) FILTER (WHERE i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}) AS overdue_installments,
           COUNT(*) FILTER (WHERE i.amount_paid >= i.amount_due) AS paid_installments,
           (SELECT i2.amount_due - i2.amount_paid FROM loan_installments i2 WHERE i2.loan_id = l.id AND i2.amount_paid < i2.amount_due ORDER BY i2.installment_number LIMIT 1) AS next_amount_due
    FROM loan_installments i WHERE i.loan_id = l.id
  ) inst ON TRUE`;

const paymentSelect = `
  SELECT p.id, p.loan_id AS "loanId", l.loan_number AS "loanNumber", l.member_id AS "memberDatabaseId", l.member_name AS "memberName",
         p.amount, p.payment_date AS "paymentDate", p.principal_paid AS "principalPaid", p.interest_paid AS "interestPaid",
         p.remaining_balance AS "remainingBalance", p.created_at AS "createdAt", u.username AS "recordedBy"
  FROM loan_payments p
  JOIN loans l ON l.id = p.loan_id
  LEFT JOIN users u ON u.id = p.recorded_by`;

const requestSelect = `
  SELECT r.id, r.member_id AS "memberDatabaseId", COALESCE(m.member_number, r.member_number) AS "memberId", r.member_number AS "memberNumber",
         r.member_name AS "memberName", r.loan_type AS "loanType", r.amount, r.term, r.purpose, r.monthly_income AS "monthlyIncome",
         r.submitted_at AS "submittedAt", r.reviewed_at AS "reviewedAt", r.status, r.review_notes AS "reviewNotes",
         r.farm_area AS "farmArea", r.maximum_eligible_amount AS "maximumEligibleAmount", r.interest_rate AS "interestRate",
         r.calculated_interest AS "calculatedInterest", r.total_repayment AS "totalRepayment", r.loan_mode AS "loanMode",
         r.co_maker_name AS "coMakerName", r.co_maker_address AS "coMakerAddress", r.co_maker_contact AS "coMakerContact",
         r.co_maker_relationship AS "coMakerRelationship", r.collateral_type AS "collateralType", r.collateral_details AS "collateralDetails",
         r.in_kind_items AS "inKindItems", r.crops_planted AS "cropsPlanted", r.crop_season AS "cropSeason", r.irrigation_type AS "irrigationType",
         r.borrower_phone AS "borrowerPhone", r.borrower_email AS "borrowerEmail"
  FROM loan_requests r LEFT JOIN members m ON m.id = r.member_id`;

const memberApplicationSelect = `SELECT id, member_number, first_name, middle_name, last_name, suffix, email, phone,
  address, barangay, municipality, province, date_of_birth, gender, civil_status, livelihood, farm_area_ha,
  TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name
  FROM members WHERE id = $1 AND status = 'active'`;

const clean = (value, max = 1000) => cleanString(value, max);
const optional = (value, max) => optionalString(value, max);

export function readDecimal(value, label, pattern = MONEY_PATTERN, max = 100000000) {
  const text = String(value ?? '').trim();
  if (!pattern.test(text) || Number(text) > max) throw badRequest(`${label} must be a valid positive amount with up to two decimal places.`);
  return text;
}

function readTerm(value) {
  const term = Number(value);
  if (!Number.isInteger(term) || term < LOAN_POLICY.minTerm || term > LOAN_POLICY.maxTerm) {
    throw badRequest(`Loan term must be a whole number from ${LOAN_POLICY.minTerm} to ${LOAN_POLICY.maxTerm} months.`);
  }
  return term;
}

function calculateAge(dateOfBirth) {
  if (!isValidDateOnly(dateOfBirth)) return null;
  const [year, month, day] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = todayDateOnly().split('-').map(Number);
  let age = ty - year;
  if (tm < month || (tm === month && td < day)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function normaliseInKindItems(rawItems, loanMode) {
  const items = Array.isArray(rawItems) ? rawItems.slice(0, 50) : [];
  const validItems = items.filter((item) => clean(item?.item, 100) || clean(item?.description, 500) || String(item?.quantity ?? '').trim() || String(item?.unitPrice ?? '').trim());
  const normalised = validItems.map((item) => {
    const quantity = readDecimal(item.quantity, 'In-kind quantity', AREA_PATTERN, 1000000);
    const unitPrice = readDecimal(item.unitPrice, 'In-kind unit price');
    const name = clean(item.item, 100);
    if (!name) throw badRequest('Each in-kind item needs a name.');
    const unit = clean(item.unit, 50);
    if (!unit) throw badRequest('Each in-kind item needs a unit.');
    return { item: name, description: clean(item.description, 500), quantity, unit, unitPrice };
  });
  if (['in-kind', 'combination'].includes(loanMode) && normalised.length === 0) {
    throw badRequest('Add at least one farm input for an in-kind or combination loan.');
  }
  return normalised;
}

export async function prepareApplication(db, body, member) {
  const loanType = clean(body.loanType || body.loan_type, 30).toLowerCase();
  const purpose = clean(body.purpose, 2000);
  const loanMode = clean(body.loanMode || body.loan_mode || 'cash', 20).toLowerCase();
  if (!loanType || !purpose) throw badRequest('Loan type and loan purpose are required.');
  if (!LOAN_TYPES.includes(loanType)) throw badRequest('Loan type must be agricultural, personal, or emergency.');
  if (!['cash', 'in-kind', 'combination'].includes(loanMode)) throw badRequest('Loan mode must be cash, in-kind, or combination.');
  const term = readTerm(body.term);
  const requestedAmount = readDecimal(body.amount ?? body.requestedAmount, 'Requested loan amount');
  if (Number(requestedAmount) <= 0) throw badRequest('Requested loan amount must be greater than zero.');
  const farmArea = readDecimal(body.farmArea ?? body.farm_area ?? member.farm_area_ha, 'Farm area', AREA_PATTERN, 10000);
  if (Number(farmArea) <= 0) throw badRequest('Farm area must be greater than zero.');
  const financials = await calculateLoanFinancials(db, { farmArea, amount: requestedAmount, term });
  if (toCents(requestedAmount) > toCents(financials.maximum_eligible_amount)) {
    throw badRequest(`Requested loan amount exceeds the maximum eligible amount of PHP ${Number(financials.maximum_eligible_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} for ${Number(farmArea)} hectares.`);
  }

  const email = clean(body.borrowerEmail, 255) || member.email || '';
  const phone = clean(body.borrowerPhone, 30) || member.phone || '';
  const address = clean(body.borrowerAddress, 2000) || member.address || '';
  if (email && !EMAIL_PATTERN.test(email)) throw badRequest('Borrower email format is invalid.');
  if (!phone || !PHONE_PATTERN.test(phone)) throw badRequest('A valid borrower contact number is required.');
  if (!address) throw badRequest('Borrower address is required.');

  const coMaker = {
    name: optional(body.coMakerName, 200), address: optional(body.coMakerAddress, 2000),
    contact: optional(body.coMakerContact, 30), relationship: optional(body.coMakerRelationship, 100),
  };
  if (Object.values(coMaker).some(Boolean) && (!coMaker.name || !coMaker.address || !coMaker.contact || !coMaker.relationship || !PHONE_PATTERN.test(coMaker.contact))) {
    throw badRequest('Complete valid co-maker information is required once a co-maker is provided.');
  }
  const collateralType = optional(body.collateralType, 100);
  const collateralDetails = optional(body.collateralDetails, 2000);
  if ((collateralType && !collateralDetails) || (!collateralType && collateralDetails)) throw badRequest('Provide both collateral type and collateral details.');
  const borrowerAge = Number(body.borrowerAge);

  return {
    loanType, purpose, loanMode, term, requestedAmount, farmArea, financials,
    borrowerEmail: email, borrowerPhone: phone, borrowerAddress: address,
    borrowerAge: Number.isInteger(borrowerAge) && borrowerAge > 0 && borrowerAge <= 120 ? borrowerAge : calculateAge(member.date_of_birth),
    borrowerGender: clean(body.borrowerGender, 30) || member.gender || null,
    borrowerCivilStatus: clean(body.borrowerCivilStatus, 30) || member.civil_status || null,
    borrowerOccupation: clean(body.borrowerOccupation, 255) || member.livelihood || null,
    yearsFarming: body.yearsFarming === '' || body.yearsFarming === undefined || body.yearsFarming === null ? null : readDecimal(body.yearsFarming, 'Years of farming', AREA_PATTERN, 100),
    farmLocation: optional(body.farmLocation, 2000), barangay: optional(body.barangay, 150) || member.barangay || null,
    municipality: optional(body.municipality, 150) || member.municipality || null, province: optional(body.province, 150) || member.province || null,
    cropsPlanted: optional(body.cropsPlanted, 1000), cropSeason: optional(body.cropSeason, 100),
    irrigationType: optional(body.irrigationType, 30), irrigationOther: optional(body.irrigationOther, 1000),
    inKindItems: normaliseInKindItems(body.inKindItems, loanMode), coMaker, collateralType, collateralDetails,
  };
}

// Inserts a loan and its installment schedule inside the caller's transaction.
async function insertLoan(client, loan) {
  const inserted = await client.query(
    `INSERT INTO loans (loan_number, loan_request_id, member_id, member_number, member_name, loan_type, amount, balance, interest_rate, term,
       date_approved, due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose, loan_mode,
       calculated_interest, total_repayment, in_kind_items, co_maker_name, co_maker_address, co_maker_contact,
       co_maker_relationship, collateral_type, collateral_details)
     VALUES ('L-TMP-' || left(md5(random()::text), 20), $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9,
       ${SQL_TODAY}, ${SQL_TODAY} + make_interval(months => $9::int), ${SQL_TODAY} + INTERVAL '1 month', $10::numeric, $11::numeric, $12::numeric,
       $13, $14, $15::numeric, $7::numeric, $16::jsonb, $17, $18, $19, $20, $21, $22)
     RETURNING id`,
    [loan.loanRequestId ?? null, loan.memberId, loan.memberNumber, loan.memberName, loan.loanType, loan.amount, loan.totalRepayment,
      loan.interestRate, loan.term, loan.monthlyPayment, loan.farmArea ?? null, loan.maximumEligibleAmount ?? null, loan.purpose ?? null,
      loan.loanMode ?? null, loan.calculatedInterest, JSON.stringify(loan.inKindItems || []), loan.coMaker?.name ?? null,
      loan.coMaker?.address ?? null, loan.coMaker?.contact ?? null, loan.coMaker?.relationship ?? null, loan.collateralType ?? null,
      loan.collateralDetails ?? null]
  );
  const loanId = inserted.rows[0].id;
  // Loan numbers follow the loan's own id so they are gap-free per loan: L-YYYY-###.
  await client.query(`UPDATE loans SET loan_number = 'L-' || TO_CHAR(${SQL_TODAY}, 'YYYY') || '-' || LPAD(id::text, 3, '0') WHERE id = $1`, [loanId]);
  await createInstallments(client, loanId);
  await recomputeLoanState(client, loanId);
  return loanId;
}

export async function getLoanPolicy(req, res) {
  return res.json({ success: true, policy: LOAN_POLICY });
}

// Server-side calculation preview used by the application form, so the
// numbers a user sees before submitting are the numbers that will be stored.
export async function quoteLoan(req, res) {
  const amountCents = parseMoneyInput(req.body?.amount ?? 0, { allowZero: true });
  const farmAreaText = String(req.body?.farmArea ?? '0').trim() || '0';
  if (amountCents === null) throw badRequest('Amount must be a valid non-negative amount.');
  if (!AREA_PATTERN.test(farmAreaText)) throw badRequest('Farm area must be a valid non-negative number.');
  const term = readTerm(req.body?.term ?? 12);
  const financials = await calculateLoanFinancials(null, { farmArea: farmAreaText, amount: centsToString(amountCents), term });
  return res.json({
    success: true,
    quote: {
      farmArea: farmAreaText,
      amount: centsToString(amountCents),
      term,
      interestRate: LOAN_POLICY.interestRate,
      maximumEligibleAmount: financials.maximum_eligible_amount,
      calculatedInterest: financials.calculated_interest,
      totalRepayment: financials.total_repayment,
      monthlyPayment: financials.monthly_payment,
      withinLimit: amountCents <= toCents(financials.maximum_eligible_amount),
    },
  });
}

function loanFilters(req) {
  const conditions = [];
  const params = [];
  const search = cleanString(req.query.search, 100);
  const status = cleanString(req.query.status, 20);
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(l.member_name ILIKE $${params.length} OR l.loan_number ILIKE $${params.length} OR COALESCE(l.member_number, '') ILIKE $${params.length})`);
  }
  if (['active', 'paid', 'overdue'].includes(status)) {
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function listLoans(req, res) {
  refreshLoanStatusesInBackground();
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const { where, params } = loanFilters(req);
  const [rows, count, summary] = await Promise.all([
    query(`${loanSelect} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM loans l ${where}`, params),
    query(
      `SELECT COUNT(*)::int AS "totalLoans",
              COUNT(*) FILTER (WHERE status = 'active')::int AS "activeLoans",
              COUNT(*) FILTER (WHERE status = 'overdue')::int AS "overdueLoans",
              COUNT(*) FILTER (WHERE status = 'paid')::int AS "paidLoans",
              COALESCE(SUM(COALESCE(total_repayment, ROUND(amount + ROUND(amount * interest_rate / 100, 2), 2))), 0) AS "totalDisbursed",
              COALESCE(SUM(amount), 0) AS "totalPrincipal",
              COALESCE(SUM(balance) FILTER (WHERE status IN ('active', 'overdue')), 0) AS "totalOutstanding",
              (SELECT COALESCE(SUM(amount), 0) FROM loan_payments) AS "totalCollected",
              (SELECT COUNT(*)::int FROM loan_requests WHERE status = 'pending') AS "pendingRequests"
       FROM loans`
    ),
  ]);
  return res.json({ success: true, loans: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].total), summary: summary.rows[0] });
}

export async function getLoan(req, res) {
  refreshLoanStatusesInBackground();
  const id = parseId(req.params.id, 'loan ID');
  const loan = await query(`${loanSelect} WHERE l.id = $1`, [id]);
  if (!loan.rows[0]) throw notFound('Loan not found.');
  const [installments, payments] = await Promise.all([
    query(
      `SELECT id, installment_number AS "number", due_date AS "dueDate", amount_due AS "amountDue", principal_due AS "principalDue",
              interest_due AS "interestDue", amount_paid AS "amountPaid", last_payment_date AS "lastPaymentDate", paid_date AS "paidDate",
              CASE WHEN amount_paid >= amount_due THEN (CASE WHEN paid_date > due_date THEN 'paid_late' ELSE 'paid' END)
                   WHEN due_date < ${SQL_TODAY} THEN 'overdue' WHEN amount_paid > 0 THEN 'partial' ELSE 'upcoming' END AS status
       FROM loan_installments WHERE loan_id = $1 ORDER BY installment_number`,
      [id]
    ),
    query(`${paymentSelect} WHERE p.loan_id = $1 ORDER BY p.payment_date DESC, p.id DESC`, [id]),
  ]);
  return res.json({ success: true, loan: loan.rows[0], installments: installments.rows, payments: payments.rows });
}

export async function listPayments(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const search = cleanString(req.query.search, 100);
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE l.member_name ILIKE $1 OR l.loan_number ILIKE $1`;
  }
  const [rows, count] = await Promise.all([
    query(`${paymentSelect} ${where} ORDER BY p.payment_date DESC, p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM loan_payments p JOIN loans l ON l.id = p.loan_id ${where}`, params),
  ]);
  return res.json({ success: true, payments: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].total) });
}

export async function listLoanRequests(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const status = cleanString(req.query.status, 20);
  const params = [];
  let where = '';
  if (['pending', 'approved', 'declined'].includes(status)) {
    params.push(status);
    where = 'WHERE r.status = $1';
  }
  const [rows, count] = await Promise.all([
    query(`${requestSelect} ${where} ORDER BY (r.status = 'pending') DESC, r.submitted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM loan_requests r ${where}`, params),
  ]);
  return res.json({ success: true, requests: rows.rows, pagination: paginationMeta(page, limit, count.rows[0].total) });
}

export async function createLoan(req, res) {
  const memberDatabaseId = parseId(req.body?.memberId, 'member');
  const loanId = await withTransaction(async (client) => {
    const member = (await client.query(`${memberApplicationSelect} FOR UPDATE`, [memberDatabaseId])).rows[0];
    if (!member) throw badRequest('Please select a valid active member.');
    const application = await prepareApplication(client, req.body || {}, member);
    const id = await insertLoan(client, {
      memberId: member.id, memberNumber: member.member_number, memberName: member.full_name, loanType: application.loanType,
      amount: application.requestedAmount, totalRepayment: application.financials.total_repayment, interestRate: LOAN_POLICY.interestRate,
      term: application.term, monthlyPayment: application.financials.monthly_payment, farmArea: application.farmArea,
      maximumEligibleAmount: application.financials.maximum_eligible_amount, purpose: application.purpose, loanMode: application.loanMode,
      calculatedInterest: application.financials.calculated_interest, inKindItems: application.inKindItems, coMaker: application.coMaker,
      collateralType: application.collateralType, collateralDetails: application.collateralDetails,
    });
    await createAuditLog({
      client,
      user: req.user,
      action: 'LOAN_CREATED',
      module: 'Loans',
      entityType: 'loan',
      entityId: String(id),
      description: `Created loan for ${member.full_name}`,
      newValues: { member_id: member.id, amount: application.requestedAmount, term: application.term, farm_area: application.farmArea, total_repayment: application.financials.total_repayment },
      ...getRequestMeta(req),
    });
    await notifyMember(client, member.id, { type: 'loan_approved', title: 'Loan approved', message: `A loan of PHP ${Number(application.requestedAmount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was approved for you.`, severity: 'success', link: '/loan-status', entityType: 'loan', entityId: id, dedupeKey: `loan-created-${id}` });
    return id;
  });
  const result = await query(`${loanSelect} WHERE l.id = $1`, [loanId]);
  return res.status(201).json({ success: true, loan: result.rows[0] });
}

export async function reviewLoanRequest(req, res) {
  const requestId = parseId(req.params.id, 'loan request ID');
  const status = req.body?.status;
  const reviewNotes = optionalString(req.body?.reason ?? req.body?.reviewNotes, 1000);
  if (!['approved', 'declined'].includes(status)) throw badRequest('Invalid request status.');

  const { request, loanId } = await withTransaction(async (client) => {
    const requestRow = (await client.query('SELECT * FROM loan_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
    if (!requestRow) throw notFound('Loan request not found.');
    if (requestRow.status !== 'pending') throw conflict('Loan request was already reviewed.');

    let createdLoanId = null;
    if (status === 'approved') {
      const member = (await client.query(`${memberApplicationSelect} FOR UPDATE`, [requestRow.member_id])).rows[0];
      if (!member) throw badRequest('This member is no longer active, so the loan cannot be approved.');
      // Requests created before migration 011 stored no rate: they keep the 8%
      // they were quoted. Everything else uses the stored application figures.
      const interestRate = requestRow.interest_rate ?? LOAN_POLICY.legacyInterestRate;
      const financials = await calculateLoanFinancials(client, { farmArea: requestRow.farm_area ?? 0, amount: requestRow.amount, term: requestRow.term, interestRate });
      createdLoanId = await insertLoan(client, {
        loanRequestId: requestRow.id, memberId: requestRow.member_id, memberNumber: requestRow.member_number || member.member_number,
        memberName: requestRow.member_name, loanType: String(requestRow.loan_type).toLowerCase(), amount: requestRow.amount,
        totalRepayment: requestRow.total_repayment ?? financials.total_repayment, interestRate, term: requestRow.term,
        monthlyPayment: financials.monthly_payment, farmArea: requestRow.farm_area, maximumEligibleAmount: requestRow.maximum_eligible_amount,
        purpose: requestRow.purpose, loanMode: requestRow.loan_mode, calculatedInterest: requestRow.calculated_interest ?? financials.calculated_interest,
        inKindItems: requestRow.in_kind_items, coMaker: { name: requestRow.co_maker_name, address: requestRow.co_maker_address, contact: requestRow.co_maker_contact, relationship: requestRow.co_maker_relationship },
        collateralType: requestRow.collateral_type, collateralDetails: requestRow.collateral_details,
      });
    }
    await client.query(`UPDATE loan_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2, review_notes = $3, updated_at = NOW() WHERE id = $4`, [status, currentUserId(req), reviewNotes, requestRow.id]);
    await createAuditLog({
      client,
      user: req.user,
      action: status === 'approved' ? 'LOAN_APPROVED' : 'LOAN_REJECTED',
      module: 'Loans',
      entityType: 'loan_request',
      entityId: String(requestRow.id),
      description: `Loan request ${status} for ${requestRow.member_name}`,
      oldValues: { status: requestRow.status },
      newValues: { status, loan_id: createdLoanId, review_notes: reviewNotes },
      ...getRequestMeta(req),
    });
    await notifyMember(client, requestRow.member_id, {
      type: status === 'approved' ? 'loan_approved' : 'loan_declined',
      title: status === 'approved' ? 'Loan application approved' : 'Loan application declined',
      message: status === 'approved'
        ? `Your ${requestRow.loan_type} loan application for PHP ${Number(requestRow.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was approved.`
        : `Your ${requestRow.loan_type} loan application was declined.${reviewNotes ? ` Reason: ${reviewNotes}` : ''}`,
      severity: status === 'approved' ? 'success' : 'error',
      link: '/loan-status',
      entityType: 'loan_request',
      entityId: requestRow.id,
      dedupeKey: `loan-request-${requestRow.id}-${status}`,
    });
    return { request: requestRow, loanId: createdLoanId };
  });

  const recipientResult = await query(
    `SELECT u.id AS user_id, COALESCE(u.email, m.email) AS email FROM members m LEFT JOIN users u ON u.member_id = m.id WHERE m.id = $1`,
    [request.member_id]
  );
  const recipient = recipientResult.rows[0];
  if (recipient?.email) {
    const loan = loanId ? (await query('SELECT total_repayment, monthly_payment, interest_rate FROM loans WHERE id = $1', [loanId])).rows[0] : null;
    const email = loanDecisionEmail({ requestId: request.id, amount: request.amount, interestRate: loan?.interest_rate, term: request.term, status, reason: reviewNotes, totalRepayment: loan?.total_repayment, monthlyPayment: loan?.monthly_payment });
    void sendEmailSafely({ ...email, to: recipient.email, relatedUserId: recipient.user_id });
  }
  return res.json({ success: true, message: `Loan request ${status}.`, loanId });
}

export async function recordPayment(req, res) {
  const loanId = parseId(req.params.id, 'loan ID');
  const amountCents = parseMoneyInput(req.body?.amount);
  const paymentDate = cleanString(req.body?.paymentDate, 10);
  if (amountCents === null) throw badRequest('Payment amount must be greater than zero with at most two decimals.');
  if (!isValidDateOnly(paymentDate)) throw badRequest('A valid payment date (YYYY-MM-DD) is required.');
  if (paymentDate > todayDateOnly()) throw badRequest('Payment date cannot be in the future.');

  const payment = await withTransaction(async (client) => {
    const loan = (await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId])).rows[0];
    if (!loan) throw notFound('Loan not found.');
    if (paymentDate < loan.date_approved) throw badRequest('Payment date cannot be before the loan approval date.');
    await ensureInstallments(client, loanId);
    const state = await recomputeLoanState(client, loanId);
    const balanceCents = toCents(state.balance);
    if (state.status === 'paid' || balanceCents <= 0) throw badRequest('This loan is already fully paid.');
    if (amountCents > balanceCents) throw badRequest(`Payment cannot exceed the outstanding balance of PHP ${centsToString(balanceCents)}.`);

    const allocation = await allocatePayment(client, loanId, amountCents, paymentDate);
    if (allocation.unallocatedCents !== 0) throw new Error(`Installment schedule does not match balance for loan ${loanId}.`);
    const remainingCents = balanceCents - amountCents;
    const inserted = await client.query(
      `INSERT INTO loan_payments (loan_id, amount, payment_date, principal_paid, interest_paid, remaining_balance, recorded_by)
       VALUES ($1, $2::numeric, $3::date, $4::numeric, $5::numeric, $6::numeric, $7) RETURNING id`,
      [loanId, centsToString(amountCents), paymentDate, centsToString(allocation.principalCents), centsToString(allocation.interestCents), centsToString(remainingCents), currentUserId(req)]
    );
    const newState = await recomputeLoanState(client, loanId);
    await createAuditLog({
      client,
      user: req.user,
      action: 'PAYMENT_CREATED',
      module: 'Payments',
      entityType: 'loan_payment',
      entityId: String(inserted.rows[0].id),
      description: `Recorded payment for loan ${loan.loan_number}`,
      oldValues: { balance: loan.balance, status: loan.status },
      newValues: { balance: newState.balance, status: newState.status, amount: centsToString(amountCents), payment_date: paymentDate, principal_paid: centsToString(allocation.principalCents), interest_paid: centsToString(allocation.interestCents) },
      ...getRequestMeta(req),
    });
    await notifyMember(client, loan.member_id, {
      type: 'payment_recorded',
      title: newState.status === 'paid' ? 'Loan fully paid' : 'Payment recorded',
      message: `Your payment of PHP ${Number(centsToString(amountCents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })} for loan ${loan.loan_number} was recorded. Remaining balance: PHP ${Number(newState.balance).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`,
      severity: 'success',
      link: '/transaction',
      entityType: 'loan_payment',
      entityId: inserted.rows[0].id,
      dedupeKey: `payment-${inserted.rows[0].id}`,
    });
    return (await client.query(`${paymentSelect} WHERE p.id = $1`, [inserted.rows[0].id])).rows[0];
  });

  const recipient = (await query(
    `SELECT u.id AS user_id, COALESCE(u.email, m.email) AS email FROM loans l LEFT JOIN members m ON m.id = l.member_id LEFT JOIN users u ON u.member_id = m.id WHERE l.id = $1`,
    [loanId]
  )).rows[0];
  if (recipient?.email) {
    const email = paymentEmail({ memberName: payment.memberName, amount: payment.amount, paymentDate: payment.paymentDate, loanNumber: payment.loanNumber, remainingBalance: payment.remainingBalance, status: Number(payment.remainingBalance) === 0 ? 'paid' : 'recorded' });
    void sendEmailSafely({ ...email, to: recipient.email, relatedUserId: recipient.user_id });
  }
  return res.status(201).json({ success: true, payment });
}

// Inserts a pending loan application inside the caller's transaction. Used by
// the member self-service form and by OCR-posted loan forms, so both land in the
// same admin approval queue.
export async function insertLoanRequest(client, req, { member, application, income, submittedBy = 'member' }) {
  const pending = await client.query(`SELECT 1 FROM loan_requests WHERE member_id = $1 AND loan_type = $2 AND status = 'pending'`, [member.id, application.loanType]);
  if (pending.rows[0]) throw conflict(submittedBy === 'member' ? 'You already have a pending application for this loan type.' : 'This member already has a pending application for this loan type.');

  const inserted = await client.query(
    `INSERT INTO loan_requests (member_id, member_number, member_name, loan_type, amount, term, purpose, monthly_income,
      borrower_email, borrower_phone, borrower_address, borrower_age, borrower_gender, borrower_civil_status, borrower_occupation,
      years_farming, farm_location, barangay, municipality, province, farm_area, crops_planted, crop_season, irrigation_type,
      irrigation_other, loan_mode, maximum_eligible_amount, interest_rate, calculated_interest, total_repayment, in_kind_items,
      co_maker_name, co_maker_address, co_maker_contact, co_maker_relationship, collateral_type, collateral_details)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16::numeric, $17, $18, $19, $20,
       $21::numeric, $22, $23, $24, $25, $26, $27::numeric, $28::numeric, $29::numeric, $30::numeric, $31::jsonb, $32, $33, $34, $35, $36, $37)
     RETURNING id`,
    [member.id, member.member_number, member.full_name, application.loanType, application.requestedAmount, application.term,
      application.purpose, income, application.borrowerEmail || null, application.borrowerPhone, application.borrowerAddress,
      application.borrowerAge, application.borrowerGender, application.borrowerCivilStatus, application.borrowerOccupation,
      application.yearsFarming, application.farmLocation, application.barangay, application.municipality, application.province,
      application.farmArea, application.cropsPlanted, application.cropSeason, application.irrigationType, application.irrigationOther,
      application.loanMode, application.financials.maximum_eligible_amount, LOAN_POLICY.interestRate,
      application.financials.calculated_interest, application.financials.total_repayment, JSON.stringify(application.inKindItems),
      application.coMaker.name, application.coMaker.address, application.coMaker.contact, application.coMaker.relationship,
      application.collateralType, application.collateralDetails]
  );
  const id = inserted.rows[0].id;
  await createAuditLog({ client, user: req.user, action: 'LOAN_APPLICATION_SUBMITTED', module: 'Loans', entityType: 'loan_request', entityId: String(id), description: `Loan application submitted by ${member.full_name}`, newValues: { amount: application.requestedAmount, term: application.term, loan_type: application.loanType }, ...getRequestMeta(req) });
  await notifyAdmins(client, {
    type: 'loan_submitted',
    title: 'Loan application received',
    message: `${member.full_name} applied for a ${application.loanType} loan of PHP ${Number(application.requestedAmount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`,
    link: '/loans',
    entityType: 'loan_request',
    entityId: id,
    dedupeKey: `loan-request-${id}-submitted`,
  });
  await notifyMember(client, member.id, { type: 'loan_submitted', title: 'Loan application submitted', message: 'Your loan application was received and is waiting for review.', link: '/loan-status', entityType: 'loan_request', entityId: id, dedupeKey: `loan-request-${id}-received` });
  return (await client.query(`${requestSelect} WHERE r.id = $1`, [id])).rows[0];
}

export async function createMemberLoanRequest(req, res) {
  const memberId = Number(req.user?.member_id);
  const request = await withTransaction(async (client) => {
    const member = (await client.query(memberApplicationSelect, [memberId])).rows[0];
    if (!member) throw badRequest('Your active member record could not be found.');
    const application = await prepareApplication(client, req.body || {}, member);
    const income = req.body?.monthlyIncome === '' || req.body?.monthlyIncome === undefined || req.body?.monthlyIncome === null ? '0' : readDecimal(req.body.monthlyIncome, 'Monthly income');
    return insertLoanRequest(client, req, { member, application, income });
  });

  void (async () => {
    const admins = await query(`SELECT id, email FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' AND email IS NOT NULL`);
    const email = loanSubmittedEmail({ memberName: request.memberName, memberNumber: request.memberNumber, amount: request.amount, requestId: request.id });
    await Promise.all(admins.rows.map((admin) => sendEmailSafely({ ...email, to: admin.email, relatedUserId: admin.id })));
  })().catch((error) => console.error('Loan submission email failed:', error.message));

  return res.status(201).json({ success: true, request });
}

export { loanSelect, memberApplicationSelect, paymentSelect, requestSelect };
