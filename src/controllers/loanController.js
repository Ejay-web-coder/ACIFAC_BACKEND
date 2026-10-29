import { query, withTransaction } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { capitalChange, createAuditLog } from '../utils/audit.js';
import { formatDateOnly, isValidDateOnly, todayDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, optionalString, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { centsToString, parseMoneyInput, toCents } from '../utils/money.js';
import { sendEmailSafely } from '../services/emailService.js';
import { loanApplicationReceivedEmail, loanDecisionEmail, loanSubmittedEmail, paymentEmail } from '../services/emailTemplates.js';
import { emailMember } from '../services/memberEmails.js';
import { sendStoredFile } from '../services/storage.js';
import { isPaymentDay, officeOpenNow, paymentHours, weekdayName } from '../services/officeHours.js';
import { keepAlive } from '../utils/background.js';
import { notifyAdmins, notifyMember } from '../services/notificationService.js';
import {
  allocatePayment, calculateLoanFinancials, createInstallments, ensureInstallments, LOAN_POLICY, recomputeLoanState, refreshLoanStatusesInBackground,
} from '../services/loanService.js';

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
// The borrower's and co-maker's IDs kept with an application or loan, without the storage paths.
const idDocumentsColumn = (alias) => `COALESCE((SELECT jsonb_object_agg(d.key, d.value - 'path') FROM jsonb_each(${alias}.id_documents) d WHERE jsonb_typeof(d.value) = 'object'), '{}'::jsonb) AS "idDocuments"`;
export const ID_HOLDERS = ['borrower', 'coMaker'];
// The borrower's signature on the application form, without the storage path.
const signatureColumn = (alias) => `(${alias}.borrower_signature - 'path') AS "borrowerSignature"`;
const AREA_PATTERN = /^\d+(\.\d{1,2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;
// ACIFAC lends for farming only.
const LOAN_TYPES = ['agricultural'];

// Every money value the API returns for a loan comes from these columns, so the
// admin page, member page, receipts and analytics always agree.
const loanSelect = `
  SELECT l.id AS "databaseId", l.loan_number AS id, l.member_id AS "memberDatabaseId",
         COALESCE(m.member_number, l.member_number, l.member_id::text) AS "memberId", l.member_name AS "memberName",
         l.loan_type AS "loanType", l.amount,
         COALESCE(l.total_repayment, ROUND(l.amount + ROUND(l.amount * l.interest_rate / 100, 2), 2)) AS "totalAmount",
         COALESCE(l.calculated_interest, ROUND(l.amount * l.interest_rate / 100, 2)) AS "totalInterest",
         l.balance, l.interest_rate AS "interestRate", l.term, l.status, l.date_approved AS "dateApproved", l.due_date AS "dueDate",
         l.next_payment_date AS "nextPaymentDate", l.monthly_payment AS "monthlyPayment", l.repayment,
         COALESCE(pay.total_paid, 0) AS "totalPaid", COALESCE(pay.payment_count, 0)::int AS "paymentCount",
         COALESCE(inst.overdue_amount, 0) AS "overdueAmount", COALESCE(inst.overdue_installments, 0)::int AS "overdueInstallments",
         COALESCE(inst.paid_installments, 0)::int AS "paidInstallments", inst.next_amount_due AS "nextAmountDue",
         l.farm_area AS "farmArea", l.maximum_eligible_amount AS "maximumEligibleAmount",
         l.purpose, l.loan_mode AS "loanMode", l.co_maker_name AS "coMakerName",
         l.co_maker_address AS "coMakerAddress", l.co_maker_contact AS "coMakerContact",
         l.co_maker_relationship AS "coMakerRelationship", l.collateral_type AS "collateralType",
         l.collateral_details AS "collateralDetails", l.in_kind_items AS "inKindItems", l.loan_request_id AS "loanRequestId",
         COALESCE(rs.restructure_count, 0)::int AS "restructureCount", rs.last_restructured_on AS "lastRestructuredOn",
         rf.loan_number AS "renewedFromLoan", rf.balance_carried AS "renewalDeduction", rf.net_proceeds AS "netProceeds",
         ${idDocumentsColumn('l')}, ${signatureColumn('l')}
  FROM loans l
  LEFT JOIN members m ON m.id = l.member_id
  LEFT JOIN LATERAL (SELECT SUM(p.amount) AS total_paid, COUNT(*) AS payment_count FROM loan_payments p WHERE p.loan_id = l.id) pay ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(i.amount_due - i.amount_paid) FILTER (WHERE i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}) AS overdue_amount,
           COUNT(*) FILTER (WHERE i.amount_paid < i.amount_due AND i.due_date < ${SQL_TODAY}) AS overdue_installments,
           COUNT(*) FILTER (WHERE i.amount_paid >= i.amount_due) AS paid_installments,
           (SELECT i2.amount_due - i2.amount_paid FROM loan_installments i2 WHERE i2.loan_id = l.id AND i2.amount_paid < i2.amount_due AND i2.superseded_by IS NULL ORDER BY i2.installment_number LIMIT 1) AS next_amount_due
    FROM loan_installments i WHERE i.loan_id = l.id AND i.superseded_by IS NULL
  ) inst ON TRUE
  LEFT JOIN LATERAL (SELECT COUNT(*) AS restructure_count, MAX(r.restructured_on) AS last_restructured_on FROM loan_restructurings r WHERE r.loan_id = l.id) rs ON TRUE
  LEFT JOIN LATERAL (
    -- A loan that restructured an earlier one: that loan, and what of this one paid it off.
    SELECT o.loan_number, r.balance_carried, r.net_proceeds FROM loan_restructurings r JOIN loans o ON o.id = r.loan_id WHERE r.new_loan_id = l.id LIMIT 1
  ) rf ON TRUE`;

const paymentSelect = `
  SELECT p.id, p.loan_id AS "loanId", l.loan_number AS "loanNumber", l.member_id AS "memberDatabaseId", l.member_name AS "memberName",
         p.amount, p.payment_date AS "paymentDate", p.principal_paid AS "principalPaid", p.interest_paid AS "interestPaid",
         p.remaining_balance AS "remainingBalance", p.created_at AS "createdAt", u.username AS "recordedBy"
  FROM loan_payments p
  JOIN loans l ON l.id = p.loan_id
  LEFT JOIN users u ON u.id = p.recorded_by`;

const restructuringSelect = `
  SELECT r.id, r.loan_id AS "loanId", r.restructured_on AS "restructuredOn", r.reason, r.balance_carried AS "balanceCarried",
         r.principal_carried AS "principalCarried", r.interest_carried AS "interestCarried", r.overdue_amount AS "overdueAmount",
         r.overdue_installments AS "overdueInstallments", r.interest_rate AS "interestRate", r.added_interest AS "addedInterest",
         r.new_term AS "newTerm", r.new_monthly_payment AS "newMonthlyPayment", r.previous_due_date AS "previousDueDate",
         r.new_due_date AS "newDueDate", r.kind, r.amount_paid_before AS "amountPaidBefore", r.total_before AS "totalBefore",
         r.new_loan_amount AS "newLoanAmount", r.net_proceeds AS "netProceeds", n.loan_number AS "newLoanNumber",
         u.username AS "recordedBy", r.created_at AS "createdAt"
  FROM loan_restructurings r LEFT JOIN users u ON u.id = r.recorded_by LEFT JOIN loans n ON n.id = r.new_loan_id`;

const requestSelect = `
  SELECT r.id, r.member_id AS "memberDatabaseId", COALESCE(m.member_number, r.member_number) AS "memberId", r.member_number AS "memberNumber",
         r.member_name AS "memberName", r.loan_type AS "loanType", r.amount, r.term, r.purpose, r.monthly_income AS "monthlyIncome",
         r.submitted_at AS "submittedAt", r.reviewed_at AS "reviewedAt", r.status, r.review_notes AS "reviewNotes",
         r.farm_area AS "farmArea", r.maximum_eligible_amount AS "maximumEligibleAmount", r.interest_rate AS "interestRate",
         r.calculated_interest AS "calculatedInterest", r.total_repayment AS "totalRepayment", r.loan_mode AS "loanMode",
         r.co_maker_name AS "coMakerName", r.co_maker_address AS "coMakerAddress", r.co_maker_contact AS "coMakerContact",
         r.co_maker_relationship AS "coMakerRelationship", r.collateral_type AS "collateralType", r.collateral_details AS "collateralDetails",
         r.in_kind_items AS "inKindItems", r.crops_planted AS "cropsPlanted", r.crop_season AS "cropSeason", r.irrigation_type AS "irrigationType",
         r.borrower_phone AS "borrowerPhone", r.borrower_email AS "borrowerEmail", ${idDocumentsColumn('r')}, ${signatureColumn('r')},
         -- The rest of the application form, for the office's View.
         r.borrower_address AS "borrowerAddress", r.borrower_age AS "borrowerAge", r.borrower_gender AS "borrowerGender",
         r.borrower_civil_status AS "borrowerCivilStatus", r.borrower_occupation AS "borrowerOccupation", r.years_farming AS "yearsFarming",
         r.farm_location AS "farmLocation", r.barangay, r.municipality, r.province, r.irrigation_other AS "irrigationOther",
         ol.loan_number AS "openLoanNumber", ol.balance AS "openLoanBalance", ol.total AS "openLoanTotal"
  FROM loan_requests r LEFT JOIN members m ON m.id = r.member_id
  LEFT JOIN LATERAL (
    -- The member's open loan, which approving this application would restructure (80% paid) or which blocks it.
    SELECT o.loan_number, o.balance, COALESCE(o.total_repayment, ROUND(o.amount + ROUND(o.amount * o.interest_rate / 100, 2), 2)) AS total
    FROM loans o WHERE o.member_id = r.member_id AND o.status <> 'paid' ORDER BY o.id LIMIT 1
  ) ol ON r.status = 'pending'`;

const memberApplicationSelect = `SELECT id, member_number, first_name, middle_name, last_name, suffix, email, phone,
  address, barangay, municipality, province, date_of_birth, gender, civil_status, livelihood, farm_area_ha, id_number,
  TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name
  FROM members WHERE id = $1 AND status = 'active'`;

const clean = (value, max = 1000) => cleanString(value, max);
const optional = (value, max) => optionalString(value, max);

export function readDecimal(value, label, pattern = MONEY_PATTERN, max = 100000000) {
  const text = String(value ?? '').trim();
  if (!pattern.test(text) || Number(text) > max) throw badRequest(`${label} must be a valid positive amount with up to two decimal places.`);
  return text;
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

// The paper loan form asks for the cash amount; the amount applied for is that
// cash plus the in-kind farm inputs (quantity x unit price), added up here.
function paperFormAmount(cashAmount, loanMode, inKindItems) {
  const cashCents = loanMode === 'in-kind' ? 0 : parseMoneyInput(String(cashAmount ?? '').trim() || '0', { allowZero: true });
  if (cashCents === null) throw badRequest('Cash amount requested must be a valid amount with up to two decimal places.');
  if (loanMode !== 'in-kind' && cashCents === 0) throw badRequest('Enter the cash amount requested.');
  const inKindCents = inKindItems.reduce((sum, item) => sum + Math.round(Number(item.quantity) * toCents(item.unitPrice)), 0);
  return centsToString(cashCents + inKindCents);
}

export async function prepareApplication(db, body, member) {
  const loanType = clean(body.loanType || body.loan_type || 'agricultural', 30).toLowerCase();
  const loanMode = clean(body.loanMode || body.loan_mode || 'cash', 20).toLowerCase();
  const cropsPlanted = optional(body.cropsPlanted, 1000);
  // The paper form has no purpose line: an agricultural loan is for the crops on it.
  const purpose = clean(body.purpose, 2000) || (loanType === 'agricultural' && cropsPlanted ? `Agricultural loan for ${cropsPlanted} (${loanMode}).` : '');
  if (!loanType || !purpose) throw badRequest('Loan type and loan purpose are required.');
  if (!LOAN_TYPES.includes(loanType)) throw badRequest('ACIFAC gives agricultural loans only.');
  if (!['cash', 'in-kind', 'combination'].includes(loanMode)) throw badRequest('Loan mode must be cash, in-kind, or combination.');
  // Every loan is for the policy's 6 months, whatever a form says.
  const term = LOAN_POLICY.loanTerm;
  // A cash loan has no farm inputs.
  const inKindItems = loanMode === 'cash' ? [] : normaliseInKindItems(body.inKindItems, loanMode);
  const requestedAmount = body.cashAmount === undefined
    ? readDecimal(body.amount ?? body.requestedAmount, 'Requested loan amount')
    : paperFormAmount(body.cashAmount, loanMode, inKindItems);
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
    cropsPlanted, cropSeason: optional(body.cropSeason, 100),
    irrigationType: optional(body.irrigationType, 30), irrigationOther: optional(body.irrigationOther, 1000),
    inKindItems, coMaker, collateralType, collateralDetails,
    // The borrower agreed to the form's certification and credit investigation (Data Privacy Act).
    certified: body.certified === true,
  };
}

// Inserts a loan and its installment schedule inside the caller's transaction.
async function insertLoan(client, loan) {
  const inserted = await client.query(
    `INSERT INTO loans (loan_number, loan_request_id, member_id, member_number, member_name, loan_type, amount, balance, interest_rate, term,
       date_approved, due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose, loan_mode,
       calculated_interest, total_repayment, in_kind_items, co_maker_name, co_maker_address, co_maker_contact,
       co_maker_relationship, collateral_type, collateral_details, id_documents, borrower_signature, repayment)
     VALUES ('L-TMP-' || left(md5(random()::text), 20), $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9,
       ${SQL_TODAY}, ${SQL_TODAY} + make_interval(months => $9::int), ${SQL_TODAY} + make_interval(months => $9::int), $10::numeric, $11::numeric, $12::numeric,
       $13, $14, $15::numeric, $7::numeric, $16::jsonb, $17, $18, $19, $20, $21, $22, $23::jsonb, $24::jsonb, '${LOAN_POLICY.repayment}')
     RETURNING id`,
    [loan.loanRequestId ?? null, loan.memberId, loan.memberNumber, loan.memberName, loan.loanType, loan.amount, loan.totalRepayment,
      loan.interestRate, loan.term, loan.monthlyPayment, loan.farmArea ?? null, loan.maximumEligibleAmount ?? null, loan.purpose ?? null,
      loan.loanMode ?? null, loan.calculatedInterest, JSON.stringify(loan.inKindItems || []), loan.coMaker?.name ?? null,
      loan.coMaker?.address ?? null, loan.coMaker?.contact ?? null, loan.coMaker?.relationship ?? null, loan.collateralType ?? null,
      loan.collateralDetails ?? null, JSON.stringify(loan.idDocuments || {}), loan.borrowerSignature ? JSON.stringify(loan.borrowerSignature) : null]
  );
  const loanId = inserted.rows[0].id;
  // Loan numbers follow the loan's own id so they are gap-free per loan: L-YYYY-###.
  await client.query(`UPDATE loans SET loan_number = 'L-' || TO_CHAR(${SQL_TODAY}, 'YYYY') || '-' || LPAD(id::text, 3, '0') WHERE id = $1`, [loanId]);
  await createInstallments(client, loanId);
  await recomputeLoanState(client, loanId);
  return loanId;
}

// paymentHours: when the office receives loan payments (open/close in minutes after midnight).
export async function getLoanPolicy(req, res) {
  const hours = paymentHours();
  return res.json({ success: true, policy: { ...LOAN_POLICY, paymentHours: { ...hours, openNow: officeOpenNow(hours) } } });
}

// Server-side calculation preview used by the application form, so the
// numbers a user sees before submitting are the numbers that will be stored.
export async function quoteLoan(req, res) {
  const amountCents = parseMoneyInput(req.body?.amount ?? 0, { allowZero: true });
  const farmAreaText = String(req.body?.farmArea ?? '0').trim() || '0';
  if (amountCents === null) throw badRequest('Amount must be a valid non-negative amount.');
  if (!AREA_PATTERN.test(farmAreaText)) throw badRequest('Farm area must be a valid non-negative number.');
  const term = LOAN_POLICY.loanTerm;
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
  const [installments, payments, restructurings] = await Promise.all([
    query(
      `SELECT id, installment_number AS "number", due_date AS "dueDate", amount_due AS "amountDue", principal_due AS "principalDue",
              interest_due AS "interestDue", amount_paid AS "amountPaid", last_payment_date AS "lastPaymentDate", paid_date AS "paidDate",
              CASE WHEN superseded_by IS NOT NULL THEN 'restructured'
                   WHEN amount_paid >= amount_due THEN (CASE WHEN paid_date > due_date THEN 'paid_late' ELSE 'paid' END)
                   WHEN due_date < ${SQL_TODAY} THEN 'overdue' WHEN amount_paid > 0 THEN 'partial' ELSE 'upcoming' END AS status
       FROM loan_installments WHERE loan_id = $1 ORDER BY installment_number`,
      [id]
    ),
    query(`${paymentSelect} WHERE p.loan_id = $1 ORDER BY p.payment_date DESC, p.id DESC`, [id]),
    query(`${restructuringSelect} WHERE r.loan_id = $1 ORDER BY r.restructured_on, r.id`, [id]),
  ]);
  return res.json({ success: true, loan: loan.rows[0], installments: installments.rows, payments: payments.rows, restructurings: restructurings.rows });
}

// A member's loans and every payment on them, with totals: the loan summary an
// admin opens from Loans & Payments and the member sees in their account.
async function memberLoanHistory(memberId) {
  const member = (await query(
    `SELECT id, member_number AS "memberNumber", TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS name, farm_area_ha AS "farmArea" FROM members WHERE id = $1`,
    [memberId]
  )).rows[0];
  if (!member) throw notFound('Member not found.');
  const [loans, payments] = await Promise.all([
    query(`${loanSelect} WHERE l.member_id = $1 ORDER BY l.date_approved DESC, l.id DESC`, [memberId]),
    query(`${paymentSelect} WHERE l.member_id = $1 ORDER BY p.payment_date DESC, p.id DESC`, [memberId]),
  ]);
  const sum = (rows, key) => centsToString(rows.reduce((total, row) => total + toCents(row[key] ?? 0), 0));
  const open = loans.rows.filter((loan) => loan.status !== 'paid');
  return {
    member,
    summary: {
      loans: loans.rows.length, openLoans: open.length, paidLoans: loans.rows.length - open.length,
      overdueLoans: loans.rows.filter((loan) => loan.status === 'overdue').length,
      totalBorrowed: sum(loans.rows, 'amount'), totalInterest: sum(loans.rows, 'totalInterest'), totalRepayment: sum(loans.rows, 'totalAmount'),
      totalPaid: sum(payments.rows, 'amount'), outstandingBalance: sum(open, 'balance'), payments: payments.rows.length,
      restructurings: loans.rows.reduce((total, loan) => total + loan.restructureCount, 0),
    },
    loans: loans.rows,
    payments: payments.rows,
  };
}

// GET /api/admin/members/:id/loan-history
export async function getMemberLoanHistory(req, res) {
  refreshLoanStatusesInBackground();
  const memberId = parseId(req.params.id, 'member ID');
  return res.json({ success: true, ...(await memberLoanHistory(memberId)) });
}

// GET /api/members/me/loan-history
export async function getMyLoanHistory(req, res) {
  refreshLoanStatusesInBackground();
  const memberId = Number(req.user?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw notFound('No member record is linked to this account.');
  return res.json({ success: true, ...(await memberLoanHistory(memberId)) });
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

// takeIds(member, application): the borrower's and co-maker's IDs, checked
// (see loanIdController), as kept in id_documents; borrowerSignature: the
// stored signature from the form's Borrower Signature line.
export async function createLoan(req, res, _next, { takeIds, borrowerSignature = null } = {}) {
  const memberDatabaseId = parseId(req.body?.memberId, 'member');
  const loanId = await withTransaction(async (client) => {
    const member = (await client.query(`${memberApplicationSelect} FOR UPDATE`, [memberDatabaseId])).rows[0];
    if (!member) throw badRequest('Please select a valid active member.');
    const application = await prepareApplication(client, req.body || {}, member);
    const open = await openLoanOf(client, member.id);
    assertMayBorrow(open, toCents(application.requestedAmount));
    const idDocuments = takeIds ? await takeIds(member, application) : {};
    const id = await insertLoan(client, {
      memberId: member.id, memberNumber: member.member_number, memberName: member.full_name, loanType: application.loanType,
      amount: application.requestedAmount, totalRepayment: application.financials.total_repayment, interestRate: LOAN_POLICY.interestRate,
      term: application.term, monthlyPayment: application.financials.monthly_payment, farmArea: application.farmArea,
      maximumEligibleAmount: application.financials.maximum_eligible_amount, purpose: application.purpose, loanMode: application.loanMode,
      calculatedInterest: application.financials.calculated_interest, inKindItems: application.inKindItems, coMaker: application.coMaker,
      collateralType: application.collateralType, collateralDetails: application.collateralDetails, idDocuments, borrowerSignature,
    });
    // With 80% of an open loan paid, the new loan restructures it.
    const renewal = open ? await closeIntoNewLoan(client, req, open, { newLoanId: id, amountCents: toCents(application.requestedAmount), reason: 'Restructured by a new loan', today: todayDateOnly() }) : null;
    if (renewal) {
      await notifyMember(client, member.id, { type: 'loan_restructured', title: 'Loan restructured', message: restructuredMessage(open, await newLoanFigures(client, id), renewal), severity: 'info', link: '/loan-status', entityType: 'loan', entityId: id, dedupeKey: `loan-restructured-${renewal.id}` });
    }
    await createAuditLog({
      client,
      user: req.user,
      action: 'LOAN_CREATED',
      module: 'Loans',
      entityType: 'loan',
      entityId: String(id),
      description: `Created loan for ${member.full_name}`,
      newValues: { member_id: member.id, amount: application.requestedAmount, capital_change: capitalChange(-(toCents(application.requestedAmount) - (renewal ? toCents(renewal.balance_carried) : 0))), term: application.term, farm_area: application.farmArea, total_repayment: application.financials.total_repayment, certified: application.certified, signed: Boolean(borrowerSignature), ids: idSummary(idDocuments) },
      ...getRequestMeta(req),
    });
    await notifyMember(client, member.id, { type: 'loan_approved', title: 'Loan approved', message: `A loan of PHP ${Number(application.requestedAmount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was approved for you.`, severity: 'success', link: '/loan-status', entityType: 'loan', entityId: id, dedupeKey: `loan-created-${id}` });
    return id;
  });
  const result = await query(`${loanSelect} WHERE l.id = $1`, [loanId]);
  const loan = result.rows[0];
  void emailMember(loan.memberDatabaseId, loanDecisionEmail({ requestId: loan.id, amount: loan.amount, interestRate: loan.interestRate, term: loan.term, status: 'approved', totalRepayment: loan.totalAmount, monthlyPayment: loan.monthlyPayment }));
  return res.status(201).json({ success: true, loan });
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
    let open = null;
    let renewal = null;
    let renewalMessage = '';
    if (status === 'approved') {
      const member = (await client.query(`${memberApplicationSelect} FOR UPDATE`, [requestRow.member_id])).rows[0];
      if (!member) throw badRequest('This member is no longer active, so the loan cannot be approved.');
      // Requests created before migration 011 stored no rate: they keep the 8%
      // they were quoted. Everything else uses the stored application figures.
      const interestRate = requestRow.interest_rate ?? LOAN_POLICY.legacyInterestRate;
      // Applications made before the 6-month single-payment policy are approved under it too.
      const financials = await calculateLoanFinancials(client, { farmArea: requestRow.farm_area ?? 0, amount: requestRow.amount, term: LOAN_POLICY.loanTerm, interestRate });
      open = await openLoanOf(client, requestRow.member_id);
      assertMayBorrow(open, toCents(requestRow.amount));
      createdLoanId = await insertLoan(client, {
        loanRequestId: requestRow.id, memberId: requestRow.member_id, memberNumber: requestRow.member_number || member.member_number,
        memberName: requestRow.member_name, loanType: String(requestRow.loan_type).toLowerCase(), amount: requestRow.amount,
        totalRepayment: requestRow.total_repayment ?? financials.total_repayment, interestRate, term: LOAN_POLICY.loanTerm,
        monthlyPayment: financials.monthly_payment, farmArea: requestRow.farm_area, maximumEligibleAmount: requestRow.maximum_eligible_amount,
        purpose: requestRow.purpose, loanMode: requestRow.loan_mode, calculatedInterest: requestRow.calculated_interest ?? financials.calculated_interest,
        inKindItems: requestRow.in_kind_items, coMaker: { name: requestRow.co_maker_name, address: requestRow.co_maker_address, contact: requestRow.co_maker_contact, relationship: requestRow.co_maker_relationship },
        collateralType: requestRow.collateral_type, collateralDetails: requestRow.collateral_details, idDocuments: requestRow.id_documents,
        borrowerSignature: requestRow.borrower_signature,
      });
      if (open) {
        renewal = await closeIntoNewLoan(client, req, open, { newLoanId: createdLoanId, amountCents: toCents(requestRow.amount), reason: `Restructured on approval of loan application #${requestRow.id}`, today: todayDateOnly() });
        renewalMessage = restructuredMessage(open, await newLoanFigures(client, createdLoanId), renewal);
      }
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
      newValues: { status, loan_id: createdLoanId, review_notes: reviewNotes, ...(createdLoanId ? { amount: requestRow.amount, capital_change: capitalChange(-(toCents(requestRow.amount) - (renewal ? toCents(renewal.balance_carried) : 0))) } : {}), ...(renewal ? { restructured_loan: open.row.loan_number, deducted: renewal.balance_carried, net_proceeds: renewal.net_proceeds } : {}) },
      ...getRequestMeta(req),
    });
    await notifyMember(client, requestRow.member_id, {
      type: status === 'approved' ? 'loan_approved' : 'loan_declined',
      title: status === 'approved' ? 'Loan application approved' : 'Loan application declined',
      message: status === 'approved'
        ? `Your ${requestRow.loan_type} loan application for PHP ${Number(requestRow.amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} was approved.${renewalMessage ? ` ${renewalMessage}` : ''}`
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
    const loan = loanId ? (await query(`SELECT total_repayment, monthly_payment, interest_rate, term, repayment, TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date FROM loans WHERE id = $1`, [loanId])).rows[0] : null;
    const email = loanDecisionEmail({
      requestId: request.id, amount: request.amount, interestRate: loan?.interest_rate, term: loan?.term ?? request.term, status, reason: reviewNotes,
      totalRepayment: loan?.total_repayment, monthlyPayment: loan?.monthly_payment, repayment: loan?.repayment, dueDate: loan?.due_date,
    });
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
  // The office receives payments on weekdays during office hours only.
  const hours = paymentHours();
  if (!isPaymentDay(paymentDate, hours)) throw badRequest(`Loan payments are received ${hours.label} only. ${formatDateOnly(paymentDate)} is a ${weekdayName(paymentDate)}.`);
  if (!officeOpenNow(hours)) throw badRequest(`Loan payments can be recorded only during office hours: ${hours.label}.`);

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
      newValues: { balance: newState.balance, status: newState.status, amount: centsToString(amountCents), capital_change: capitalChange(amountCents), payment_date: paymentDate, principal_paid: centsToString(allocation.principalCents), interest_paid: centsToString(allocation.interestCents) },
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

const pesoText = (cents) => `PHP ${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// An open loan's standing, inside the caller's transaction with the loan row
// locked: what is still owed and what has been paid of its total. Null when it
// is already fully paid.
async function loanStanding(client, row) {
  await ensureInstallments(client, row.id);
  const state = await recomputeLoanState(client, row.id);
  const balanceCents = toCents(state.balance);
  if (state.status === 'paid' || balanceCents <= 0) return null;
  const paidCents = toCents((await client.query('SELECT COALESCE(SUM(amount), 0) AS paid FROM loan_payments WHERE loan_id = $1', [row.id])).rows[0].paid);
  return { row, state, balanceCents, paidCents, totalCents: paidCents + balanceCents };
}

// A member has one loan at a time: the member's open loan (locked), or null.
async function openLoanOf(client, memberId) {
  const rows = (await client.query(`SELECT * FROM loans WHERE member_id = $1 AND status <> 'paid' ORDER BY id FOR UPDATE`, [memberId])).rows;
  const open = [];
  for (const row of rows) {
    const standing = await loanStanding(client, row);
    if (standing) open.push(standing);
  }
  if (open.length > 1) throw conflict(`This member has ${open.length} open loans (${open.map((loan) => loan.row.loan_number).join(', ')}). Settle all but one before a new loan.`);
  return open[0] ?? null;
}

const paidPercent = (open) => Math.floor((open.paidCents * 1000) / open.totalCents) / 10;

// A member with an open loan may borrow again only once at least 80% of it is
// paid (restructuring): the new loan must cover what is still owed, which is
// deducted from it. `subject` is "You have" or "This member has".
function assertMayBorrow(open, amountCents, subject = 'This member has') {
  if (!open) return;
  const minPercent = LOAN_POLICY.renewalMinPaidPercent;
  if (open.paidCents * 100 < open.totalCents * minPercent) {
    const neededCents = Math.ceil((open.totalCents * minPercent) / 100) - open.paidCents;
    throw conflict(`${subject} an open loan (${open.row.loan_number}): ${pesoText(open.paidCents)} of ${pesoText(open.totalCents)} is paid (${paidPercent(open)}%). A new loan is possible once at least ${minPercent}% is paid, ${pesoText(neededCents)} more; what is still owed is then deducted from the new loan (restructuring).`);
  }
  if (amountCents <= open.balanceCents) throw badRequest(`The new loan must be more than the ${pesoText(open.balanceCents)} still owed on loan ${open.row.loan_number}, which is deducted from it.`);
}

// Restructuring: what is still owed on the open loan is deducted from the new
// loan's proceeds and recorded as the old loan's last payment, which closes it.
// Returns the restructuring row (balance_carried is the deduction).
async function closeIntoNewLoan(client, req, open, { newLoanId, amountCents, reason, today }) {
  const loanId = open.row.id;
  // What was past due on the old loan, for the credit history.
  const overdue = (await client.query(
    `SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS amount, COUNT(*)::int AS count
     FROM loan_installments WHERE loan_id = $1 AND amount_paid < amount_due AND superseded_by IS NULL AND due_date < $2::date`,
    [loanId, today]
  )).rows[0];
  const allocation = await allocatePayment(client, loanId, open.balanceCents, today);
  if (allocation.unallocatedCents !== 0) throw new Error(`Installment schedule does not match balance for loan ${loanId}.`);
  const payment = (await client.query(
    `INSERT INTO loan_payments (loan_id, amount, payment_date, principal_paid, interest_paid, remaining_balance, recorded_by)
     VALUES ($1, $2::numeric, $3::date, $4::numeric, $5::numeric, 0, $6) RETURNING id`,
    [loanId, centsToString(open.balanceCents), today, centsToString(allocation.principalCents), centsToString(allocation.interestCents), currentUserId(req)]
  )).rows[0];
  await recomputeLoanState(client, loanId);
  const newDueDate = (await client.query('SELECT due_date FROM loans WHERE id = $1', [newLoanId])).rows[0].due_date;
  return (await client.query(
    `INSERT INTO loan_restructurings (loan_id, kind, restructured_on, reason, balance_carried, principal_carried, interest_carried, overdue_amount, overdue_installments,
                                      interest_rate, previous_due_date, new_due_date, amount_paid_before, total_before, new_loan_id, new_loan_amount, net_proceeds, payment_id, recorded_by)
     VALUES ($1, 'renewal', $2::date, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::int, $9::numeric, $10::date, $11::date,
             $12::numeric, $13::numeric, $14, $15::numeric, $15::numeric - $4::numeric, $16, $17)
     RETURNING *`,
    [loanId, today, reason, centsToString(open.balanceCents), centsToString(allocation.principalCents), centsToString(allocation.interestCents), overdue.amount, overdue.count,
      LOAN_POLICY.interestRate, open.row.due_date, newDueDate, centsToString(open.paidCents), centsToString(open.totalCents), newLoanId, centsToString(amountCents), payment.id, currentUserId(req)]
  )).rows[0];
}

// The words the member is told when a new loan restructured their open one.
const restructuredMessage = (open, newLoan, restructuring) =>
  `Your loan ${open.row.loan_number} was restructured into the new loan ${newLoan.loan_number} of ${pesoText(toCents(newLoan.amount))}. The ${pesoText(open.balanceCents)} still owed was deducted, so you receive ${pesoText(toCents(restructuring.net_proceeds))}. The new loan, ${pesoText(toCents(newLoan.total))} with interest, is due by ${formatDateOnly(newLoan.due_date)}.`;
const newLoanFigures = async (client, loanId) => (await client.query(
  `SELECT loan_number, amount, due_date, COALESCE(total_repayment, ROUND(amount + ROUND(amount * interest_rate / 100, 2), 2)) AS total FROM loans WHERE id = $1`, [loanId]
)).rows[0];

// POST /api/admin/loans/:id/restructure { amount, farmArea, reason }
// Restructures a loan the borrower has paid at least 80% of (principal and
// interest) into a new one: a loan of `amount` (at most farm area x PHP 50,000,
// at the policy's interest, due in 6 months) whose proceeds first pay off what
// is still owed on the old loan (see closeIntoNewLoan); the borrower receives the rest.
export async function restructureLoanRequest(req, res) {
  const loanId = parseId(req.params.id, 'loan ID');
  const amount = readDecimal(req.body?.amount, 'New loan amount');
  const amountCents = toCents(amount);
  if (amountCents <= 0) throw badRequest('New loan amount must be greater than zero.');
  const reason = clean(req.body?.reason, 1000);
  if (!reason) throw badRequest('Enter the reason for restructuring the loan.');
  const today = todayDateOnly();

  const { loan, newLoanId, restructuring } = await withTransaction(async (client) => {
    const row = (await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loanId])).rows[0];
    if (!row) throw notFound('Loan not found.');
    const open = await loanStanding(client, row);
    if (!open) throw conflict('This loan is already fully paid, so there is nothing to restructure.');
    const minPercent = LOAN_POLICY.renewalMinPaidPercent;
    if (open.paidCents * 100 < open.totalCents * minPercent) {
      const neededCents = Math.ceil((open.totalCents * minPercent) / 100) - open.paidCents;
      throw conflict(`A loan can be restructured once at least ${minPercent}% of it is paid. ${pesoText(open.paidCents)} of ${pesoText(open.totalCents)} is paid (${paidPercent(open)}%); ${pesoText(neededCents)} more is needed.`);
    }

    const member = row.member_id ? (await client.query(`${memberApplicationSelect} FOR UPDATE`, [row.member_id])).rows[0] : null;
    if (!member) throw badRequest('This member is no longer active, so the loan cannot be restructured into a new one.');
    const farmArea = readDecimal(req.body?.farmArea ?? row.farm_area ?? member.farm_area_ha, 'Farm area', AREA_PATTERN, 10000);
    if (Number(farmArea) <= 0) throw badRequest('Farm area must be greater than zero.');
    const financials = await calculateLoanFinancials(client, { farmArea, amount, term: LOAN_POLICY.loanTerm });
    if (amountCents > toCents(financials.maximum_eligible_amount)) {
      throw badRequest(`New loan amount exceeds the maximum eligible amount of ${pesoText(toCents(financials.maximum_eligible_amount))} for ${Number(farmArea)} hectares.`);
    }
    assertMayBorrow(open, amountCents);

    const createdLoanId = await insertLoan(client, {
      memberId: row.member_id, memberNumber: row.member_number || member.member_number, memberName: row.member_name,
      loanType: row.loan_type, amount, totalRepayment: financials.total_repayment, interestRate: LOAN_POLICY.interestRate, term: LOAN_POLICY.loanTerm,
      monthlyPayment: financials.monthly_payment, farmArea, maximumEligibleAmount: financials.maximum_eligible_amount,
      purpose: row.purpose, loanMode: 'cash', calculatedInterest: financials.calculated_interest,
      coMaker: { name: row.co_maker_name, address: row.co_maker_address, contact: row.co_maker_contact, relationship: row.co_maker_relationship },
      collateralType: row.collateral_type, collateralDetails: row.collateral_details, idDocuments: row.id_documents,
    });
    const result = await closeIntoNewLoan(client, req, open, { newLoanId: createdLoanId, amountCents, reason, today });
    const newLoan = await newLoanFigures(client, createdLoanId);

    await createAuditLog({
      client,
      user: req.user,
      action: 'LOAN_RESTRUCTURED',
      module: 'Loans',
      entityType: 'loan',
      entityId: String(loanId),
      description: `Restructured loan ${row.loan_number} of ${row.member_name} into loan ${newLoan.loan_number}`,
      oldValues: { balance: open.state.balance, status: open.state.status, amount_paid: centsToString(open.paidCents), total: centsToString(open.totalCents) },
      newValues: {
        status: 'paid', deducted: result.balance_carried, new_loan_id: createdLoanId, new_loan_number: newLoan.loan_number, new_loan_amount: amount,
        net_proceeds: result.net_proceeds, capital_change: capitalChange(-toCents(result.net_proceeds)), farm_area: farmArea, due_date: newLoan.due_date, reason,
      },
      ...getRequestMeta(req),
    });
    await notifyMember(client, row.member_id, {
      type: 'loan_restructured', title: 'Loan restructured', message: restructuredMessage(open, newLoan, result),
      severity: 'info', link: '/loan-status', entityType: 'loan', entityId: createdLoanId, dedupeKey: `loan-restructured-${result.id}`,
    });
    return { loan: row, newLoanId: createdLoanId, restructuring: result };
  });
  const [created, previous] = await Promise.all([
    query(`${loanSelect} WHERE l.id = $1`, [newLoanId]),
    query(`${loanSelect} WHERE l.id = $1`, [loanId]),
  ]);
  return res.status(201).json({ success: true, loan: created.rows[0], previousLoan: previous.rows[0], restructuring: { ...restructuring, loanNumber: loan.loan_number } });
}

// Inserts a pending loan application inside the caller's transaction. Used by
// the member self-service form and by OCR-posted loan forms, so both land in the
// same admin approval queue.
export async function insertLoanRequest(client, req, { member, application, income, submittedBy = 'member', idDocuments = {}, borrowerSignature = null }) {
  const pending = await client.query(`SELECT 1 FROM loan_requests WHERE member_id = $1 AND loan_type = $2 AND status = 'pending'`, [member.id, application.loanType]);
  if (pending.rows[0]) throw conflict(submittedBy === 'member' ? 'You already have a pending loan application.' : 'This member already has a pending loan application.');
  assertMayBorrow(await openLoanOf(client, member.id), toCents(application.requestedAmount), submittedBy === 'member' ? 'You have' : 'This member has');

  const inserted = await client.query(
    `INSERT INTO loan_requests (member_id, member_number, member_name, loan_type, amount, term, purpose, monthly_income,
      borrower_email, borrower_phone, borrower_address, borrower_age, borrower_gender, borrower_civil_status, borrower_occupation,
      years_farming, farm_location, barangay, municipality, province, farm_area, crops_planted, crop_season, irrigation_type,
      irrigation_other, loan_mode, maximum_eligible_amount, interest_rate, calculated_interest, total_repayment, in_kind_items,
      co_maker_name, co_maker_address, co_maker_contact, co_maker_relationship, collateral_type, collateral_details, id_documents, borrower_signature)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16::numeric, $17, $18, $19, $20,
       $21::numeric, $22, $23, $24, $25, $26, $27::numeric, $28::numeric, $29::numeric, $30::numeric, $31::jsonb, $32, $33, $34, $35, $36, $37, $38::jsonb, $39::jsonb)
     RETURNING id`,
    [member.id, member.member_number, member.full_name, application.loanType, application.requestedAmount, application.term,
      application.purpose, income, application.borrowerEmail || null, application.borrowerPhone, application.borrowerAddress,
      application.borrowerAge, application.borrowerGender, application.borrowerCivilStatus, application.borrowerOccupation,
      application.yearsFarming, application.farmLocation, application.barangay, application.municipality, application.province,
      application.farmArea, application.cropsPlanted, application.cropSeason, application.irrigationType, application.irrigationOther,
      application.loanMode, application.financials.maximum_eligible_amount, LOAN_POLICY.interestRate,
      application.financials.calculated_interest, application.financials.total_repayment, JSON.stringify(application.inKindItems),
      application.coMaker.name, application.coMaker.address, application.coMaker.contact, application.coMaker.relationship,
      application.collateralType, application.collateralDetails, JSON.stringify(Object.fromEntries(Object.entries(idDocuments).filter(([, value]) => value))),
      borrowerSignature ? JSON.stringify(borrowerSignature) : null]
  );
  const id = inserted.rows[0].id;
  await createAuditLog({ client, user: req.user, action: 'LOAN_APPLICATION_SUBMITTED', module: 'Loans', entityType: 'loan_request', entityId: String(id), description: `Loan application submitted by ${member.full_name}`, newValues: { amount: application.requestedAmount, term: application.term, loan_type: application.loanType, certified: application.certified, signed: Boolean(borrowerSignature), ids: idSummary(idDocuments) }, ...getRequestMeta(req) });
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

export async function createMemberLoanRequest(req, res, _next, { takeIds, borrowerSignature = null } = {}) {
  const memberId = Number(req.user?.member_id);
  const request = await withTransaction(async (client) => {
    const member = (await client.query(memberApplicationSelect, [memberId])).rows[0];
    if (!member) throw badRequest('Your active member record could not be found.');
    const application = await prepareApplication(client, req.body || {}, member);
    const income = req.body?.monthlyIncome === '' || req.body?.monthlyIncome === undefined || req.body?.monthlyIncome === null ? '0' : readDecimal(req.body.monthlyIncome, 'Monthly income');
    const idDocuments = takeIds ? await takeIds(member, application) : {};
    return insertLoanRequest(client, req, { member, application, income, idDocuments, borrowerSignature });
  });

  void keepAlive((async () => {
    const admins = await query(`SELECT id, email FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' AND email IS NOT NULL`);
    const email = loanSubmittedEmail({ memberName: request.memberName, memberNumber: request.memberNumber, amount: request.amount, requestId: request.id });
    await Promise.all(admins.rows.map((admin) => sendEmailSafely({ ...email, to: admin.email, relatedUserId: admin.id })));
  })().catch((error) => console.error('Loan submission email failed:', error.message)));

  void emailMember(request.memberDatabaseId, (recipient) => loanApplicationReceivedEmail({ memberName: recipient.full_name, requestId: request.id, amount: request.amount, loanType: request.loanType, term: request.term }));
  return res.status(201).json({ success: true, request });
}

// For the audit log: which IDs came with the application, and how their checks ended.
function idSummary(idDocuments) {
  return Object.fromEntries(Object.entries(idDocuments || {}).filter(([, value]) => value).map(([holder, value]) => [holder, {
    source: value.source, id_type: value.reading?.idType || null, signatures: value.reading?.signatureCount ?? null,
    checks: (value.checks || []).map((check) => `${check.id}:${check.status}`),
  }]));
}

// GET /api/admin/loan-requests/:id/id-documents/:holder and /api/admin/loans/:id/id-documents/:holder
function downloadIdFrom(table) {
  return async (req, res) => {
    const id = parseId(req.params.id, table === 'loans' ? 'loan ID' : 'loan request ID');
    const holder = req.params.holder;
    if (!ID_HOLDERS.includes(holder)) throw notFound('Document not found.');
    const row = (await query(`SELECT id_documents -> $2 AS document FROM ${table} WHERE id = $1`, [id, holder])).rows[0];
    const document = row?.document;
    if (!document?.path) throw notFound(holder === 'coMaker' ? 'No co-maker ID was submitted with this application.' : 'No borrower ID was submitted with this application.');
    const sent = await sendStoredFile(res, { reference: document.path, mimeType: document.mimeType, fileName: document.fileName });
    if (!sent) throw notFound('The stored file is no longer available.');
    return undefined;
  };
}

export const downloadLoanRequestId = downloadIdFrom('loan_requests');
export const downloadLoanId = downloadIdFrom('loans');

// GET /api/admin/loan-requests/:id/borrower-signature and /api/admin/loans/:id/borrower-signature
function downloadSignatureFrom(table) {
  return async (req, res) => {
    const id = parseId(req.params.id, table === 'loans' ? 'loan ID' : 'loan request ID');
    const signature = (await query(`SELECT borrower_signature FROM ${table} WHERE id = $1`, [id])).rows[0]?.borrower_signature;
    if (!signature?.path) throw notFound('The borrower did not sign this application in the app.');
    const sent = await sendStoredFile(res, { reference: signature.path, mimeType: signature.mimeType, fileName: signature.fileName });
    if (!sent) throw notFound('The stored file is no longer available.');
    return undefined;
  };
}

export const downloadLoanRequestSignature = downloadSignatureFrom('loan_requests');
export const downloadLoanSignature = downloadSignatureFrom('loans');

export { loanSelect, memberApplicationSelect, paymentSelect, requestSelect };
