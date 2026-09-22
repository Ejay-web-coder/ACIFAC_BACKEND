import { query, getPool } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { sendEmailSafely } from '../services/emailService.js';
import { loanDecisionEmail, loanSubmittedEmail, paymentEmail } from '../services/emailTemplates.js';

// Agricultural-loan policy values live here so an authorized configuration
// source can replace them later without changing routes or UI code.
export const MAX_LOAN_PER_HECTARE = '50000';
export const DEFAULT_INTEREST_RATE = '2.5';
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;
const AREA_PATTERN = /^\d+(\.\d{1,2})?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;

const loanSelect = `
    SELECT l.id AS "databaseId", l.loan_number AS id, COALESCE(m.member_number, l.member_number, l.member_id::text) AS "memberId", l.member_name AS "memberName",
      l.loan_type AS "loanType", l.amount, COALESCE(l.total_repayment, ROUND((l.amount * (1 + l.interest_rate / 100)), 2)) AS "totalAmount",
      COALESCE(l.calculated_interest, ROUND((l.amount * l.interest_rate / 100), 2)) AS "totalInterest", l.balance, l.interest_rate AS "interestRate",
         l.term, l.status, l.date_approved AS "dateApproved", l.due_date AS "dueDate",
         l.next_payment_date AS "nextPaymentDate", l.monthly_payment AS "monthlyPayment",
         l.farm_area AS "farmArea", l.maximum_eligible_amount AS "maximumEligibleAmount",
         l.purpose, l.loan_mode AS "loanMode", l.calculated_interest AS "calculatedInterest",
         l.total_repayment AS "totalRepayment", l.co_maker_name AS "coMakerName",
         l.co_maker_address AS "coMakerAddress", l.co_maker_contact AS "coMakerContact",
         l.co_maker_relationship AS "coMakerRelationship", l.collateral_type AS "collateralType",
         l.collateral_details AS "collateralDetails", l.in_kind_items AS "inKindItems"
  FROM loans l LEFT JOIN members m ON m.id = l.member_id`;

const memberApplicationSelect = `SELECT id, member_number, first_name, middle_name, last_name, suffix, email, phone,
  address, barangay, municipality, province, date_of_birth, gender, civil_status, livelihood, farm_area_ha,
  TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name
  FROM members WHERE id = $1 AND status = 'active'`;

const clean = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const optional = (value, max) => clean(value, max) || null;

function readDecimal(value, label, pattern = MONEY_PATTERN, max = 100000000) {
  const text = String(value ?? '').trim();
  if (!pattern.test(text) || Number(text) > max) throw new Error(`${label} must be a valid positive amount with up to two decimal places.`);
  return text;
}

function readTerm(value) {
  const term = Number(value);
  if (!Number.isInteger(term) || term < 1 || term > 60) throw new Error('Loan term must be a whole number from 1 to 60 months.');
  return term;
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const birth = new Date(dateOfBirth);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const month = today.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

async function calculateFinancials(farmArea, requestedAmount, term) {
  // PostgreSQL NUMERIC is the financial source of truth; no client total is used.
  const result = await query(
    `SELECT ROUND($1::numeric * $2::numeric, 2) AS maximum_eligible_amount,
            ROUND($3::numeric * ($4::numeric / 100), 2) AS calculated_interest,
            ROUND($3::numeric * (1 + ($4::numeric / 100)), 2) AS total_repayment,
            ROUND(($3::numeric * (1 + ($4::numeric / 100))) / $5::numeric, 2) AS monthly_payment`,
    [farmArea, MAX_LOAN_PER_HECTARE, requestedAmount, DEFAULT_INTEREST_RATE, term]
  );
  return result.rows[0];
}

function normaliseInKindItems(rawItems, loanMode) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const validItems = items.filter((item) => clean(item?.item, 100) || clean(item?.description, 500) || String(item?.quantity ?? '').trim() || String(item?.unitPrice ?? '').trim());
  const normalised = validItems.map((item) => {
    const quantity = readDecimal(item.quantity, 'In-kind quantity', AREA_PATTERN, 1000000);
    const unitPrice = readDecimal(item.unitPrice, 'In-kind unit price');
    const name = clean(item.item, 100);
    if (!name) throw new Error('Each in-kind item needs a name.');
    const unit = clean(item.unit, 50);
    if (!unit) throw new Error('Each in-kind item needs a unit.');
    return { item: name, description: clean(item.description, 500), quantity, unit, unitPrice };
  });
  if (['in-kind', 'combination'].includes(loanMode) && normalised.length === 0) {
    throw new Error('Add at least one farm input for an in-kind or combination loan.');
  }
  return normalised;
}

async function prepareApplication(body, member) {
  const loanType = clean(body.loanType || body.loan_type, 30).toLowerCase();
  const purpose = clean(body.purpose, 2000);
  const loanMode = clean(body.loanMode || body.loan_mode || 'cash', 20).toLowerCase();
  if (!loanType || !purpose) throw new Error('Loan type and loan purpose are required.');
  if (!['cash', 'in-kind', 'combination'].includes(loanMode)) throw new Error('Loan mode must be cash, in-kind, or combination.');
  const term = readTerm(body.term);
  const requestedAmount = readDecimal(body.amount ?? body.requestedAmount, 'Requested loan amount');
  if (Number(requestedAmount) <= 0) throw new Error('Requested loan amount must be greater than zero.');
  const farmArea = readDecimal(body.farmArea ?? body.farm_area ?? member.farm_area_ha, 'Farm area', AREA_PATTERN, 10000);
  if (Number(farmArea) <= 0) throw new Error('Farm area must be greater than zero.');
  const financials = await calculateFinancials(farmArea, requestedAmount, term);
  if (Number(requestedAmount) > Number(financials.maximum_eligible_amount)) {
    throw new Error(`Requested loan amount exceeds the maximum eligible amount of PHP ${Number(financials.maximum_eligible_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })} for ${Number(farmArea)} hectares.`);
  }

  const email = clean(body.borrowerEmail, 255) || member.email || '';
  const phone = clean(body.borrowerPhone, 30) || member.phone || '';
  const address = clean(body.borrowerAddress, 2000) || member.address || '';
  if (!email || !EMAIL_PATTERN.test(email)) throw new Error('A valid borrower email is required.');
  if (!phone || !PHONE_PATTERN.test(phone)) throw new Error('A valid borrower contact number is required.');
  if (!address) throw new Error('Borrower address is required.');

  const coMaker = {
    name: optional(body.coMakerName, 200), address: optional(body.coMakerAddress, 2000),
    contact: optional(body.coMakerContact, 30), relationship: optional(body.coMakerRelationship, 100),
  };
  if (Object.values(coMaker).some(Boolean) && (!coMaker.name || !coMaker.address || !coMaker.contact || !coMaker.relationship || !PHONE_PATTERN.test(coMaker.contact))) {
    throw new Error('Complete valid co-maker information is required once a co-maker is provided.');
  }
  const collateralType = optional(body.collateralType, 100);
  const collateralDetails = optional(body.collateralDetails, 2000);
  if ((collateralType && !collateralDetails) || (!collateralType && collateralDetails)) throw new Error('Provide both collateral type and collateral details.');

  return {
    loanType, purpose, loanMode, term, requestedAmount, farmArea, financials,
    borrowerEmail: email, borrowerPhone: phone, borrowerAddress: address,
    borrowerAge: Number.isInteger(Number(body.borrowerAge)) ? Number(body.borrowerAge) : calculateAge(member.date_of_birth),
    borrowerGender: clean(body.borrowerGender, 30) || member.gender || null,
    borrowerCivilStatus: clean(body.borrowerCivilStatus, 30) || member.civil_status || null,
    borrowerOccupation: clean(body.borrowerOccupation, 255) || member.livelihood || null,
    yearsFarming: body.yearsFarming === '' || body.yearsFarming === undefined ? null : readDecimal(body.yearsFarming, 'Years of farming', AREA_PATTERN, 100),
    farmLocation: optional(body.farmLocation, 2000), barangay: optional(body.barangay, 150) || member.barangay || null,
    municipality: optional(body.municipality, 150) || member.municipality || null, province: optional(body.province, 150) || member.province || null,
    cropsPlanted: optional(body.cropsPlanted, 1000), cropSeason: optional(body.cropSeason, 100),
    irrigationType: optional(body.irrigationType, 30), irrigationOther: optional(body.irrigationOther, 1000),
    inKindItems: normaliseInKindItems(body.inKindItems, loanMode), coMaker, collateralType, collateralDetails,
  };
}

function getRequestMeta(req) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

async function notifyAdminsAboutLoan(request) {
  const admins = await query(`SELECT id, member_id, email FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' AND email IS NOT NULL`, []);
  const email = loanSubmittedEmail({ memberName: request.member_name, memberNumber: request.member_number, amount: request.amount, submittedAt: request.submitted_at, status: request.status, requestId: request.id });
  await Promise.all(admins.rows.map((admin) => sendEmailSafely({ ...email, to: admin.email, notificationType: 'loan_submitted', dedupeKey: String(request.id), relatedUserId: admin.id, relatedMemberId: request.member_id })));
}

export async function listLoansData(req, res) {
  try {
    const [loans, payments, requests] = await Promise.all([
      query(`${loanSelect} ORDER BY l.created_at DESC`),
      query(`SELECT p.id, p.loan_id AS "loanId", l.member_name AS "memberName", p.amount,
                    p.payment_date AS "paymentDate", p.principal_paid AS "principalPaid",
                    p.interest_paid AS "interestPaid", p.remaining_balance AS "remainingBalance"
             FROM loan_payments p JOIN loans l ON l.id = p.loan_id
             ORDER BY p.payment_date DESC, p.id DESC`),
      query(`SELECT id, member_id AS "memberId", member_number AS "memberNumber", member_name AS "memberName", loan_type AS "loanType",
                    amount, term, purpose, monthly_income AS "monthlyIncome", submitted_at AS "submittedAt", status,
                    farm_area AS "farmArea", maximum_eligible_amount AS "maximumEligibleAmount", interest_rate AS "interestRate",
                    calculated_interest AS "calculatedInterest", total_repayment AS "totalRepayment", loan_mode AS "loanMode",
                    co_maker_name AS "coMakerName", co_maker_address AS "coMakerAddress", co_maker_contact AS "coMakerContact",
                    co_maker_relationship AS "coMakerRelationship", collateral_type AS "collateralType", collateral_details AS "collateralDetails",
                    in_kind_items AS "inKindItems"
             FROM loan_requests ORDER BY submitted_at DESC`),
    ]);
    return res.json({ loans: loans.rows, payments: payments.rows, requests: requests.rows });
  } catch (error) {
    console.error('List loans data error:', error);
    return res.status(500).json({ message: 'Unable to load loans and payments.' });
  }
}

export async function createLoan(req, res) {
  try {
    const memberDatabaseId = Number(req.body?.memberId);
    if (!Number.isInteger(memberDatabaseId) || memberDatabaseId <= 0) return res.status(400).json({ message: 'Please select a valid active member.' });
    const memberResult = await query(memberApplicationSelect, [memberDatabaseId]);
    const member = memberResult.rows[0];
    if (!member) return res.status(400).json({ message: 'Please select a valid active member.' });
    const application = await prepareApplication(req.body || {}, member);

    const loan = await query(
      `INSERT INTO loans (loan_number, member_id, member_number, member_name, loan_type, amount, balance, interest_rate, term,
        due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose, loan_mode,
        calculated_interest, total_repayment, in_kind_items, co_maker_name, co_maker_address, co_maker_contact,
        co_maker_relationship, collateral_type, collateral_details)
       VALUES ('L-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('loans_id_seq')::text, 3, '0'), $1, $2, $3, $4,
        $5::numeric, $6::numeric, $7::numeric, $8, CURRENT_DATE + make_interval(months => $8::int), CURRENT_DATE + INTERVAL '1 month',
        $9::numeric, $10::numeric, $11::numeric, $12, $13, $14::numeric, $15::numeric, $16::jsonb, $17, $18, $19, $20, $21, $22)
       RETURNING id`, [member.id, member.member_number, member.full_name, application.loanType, application.requestedAmount,
        application.financials.total_repayment, DEFAULT_INTEREST_RATE, application.term, application.financials.monthly_payment,
        application.farmArea, application.financials.maximum_eligible_amount, application.purpose, application.loanMode,
        application.financials.calculated_interest, application.financials.total_repayment, JSON.stringify(application.inKindItems),
        application.coMaker.name, application.coMaker.address, application.coMaker.contact, application.coMaker.relationship,
        application.collateralType, application.collateralDetails]
    );
    const result = await query(`${loanSelect} WHERE l.id = $1`, [loan.rows[0].id]);
    await createAuditLog({
      user: req.user,
      action: 'LOAN_CREATED',
      module: 'Loans',
      entityType: 'loan',
      entityId: String(loan.rows[0].id),
      description: `Created loan ${result.rows[0].id} for ${member.full_name}`,
      oldValues: {},
      newValues: { member_id: member.id, member_name: member.full_name, amount: application.requestedAmount, term: application.term, farm_area: application.farmArea, maximum_eligible_amount: application.financials.maximum_eligible_amount },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    return res.status(201).json({ loan: result.rows[0] });
  } catch (error) {
    console.error('Create loan error:', error);
    return res.status(error.message ? 400 : 500).json({ message: error.message || 'Unable to create loan.' });
  }
}

export async function reviewLoanRequest(req, res) {
  const client = await getPool().connect();
  try {
    const { status } = req.body || {};
    if (!['approved', 'declined'].includes(status)) return res.status(400).json({ message: 'Invalid request status.' });
    await client.query('BEGIN');
    const requestResult = await client.query('SELECT * FROM loan_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    const request = requestResult.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Loan request not found.' });
    }
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Loan request was already reviewed.' });
    }
    await client.query(`UPDATE loan_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3`, [status, req.user.user_id, request.id]);
    if (status === 'approved') {
      // Requests created before migration 011 did not store a rate. Preserve the
      // historical approval rule (8%) for those legacy records only.
      const interestRate = request.interest_rate ?? 8;
      const totalRepayment = request.total_repayment ?? await client.query(
        `SELECT ROUND($1::numeric * (1 + ($2::numeric / 100)), 2) AS total`, [request.amount, interestRate]
      ).then((result) => result.rows[0].total);
      const calculatedInterest = request.calculated_interest ?? await client.query(
        `SELECT ROUND($1::numeric * ($2::numeric / 100), 2) AS interest`, [request.amount, interestRate]
      ).then((result) => result.rows[0].interest);
      const monthlyPayment = await client.query(
        `SELECT ROUND($1::numeric / $2::numeric, 2) AS monthly`, [totalRepayment, request.term]
      ).then((result) => result.rows[0].monthly);
      await client.query(
        `INSERT INTO loans (loan_number, loan_request_id, member_id, member_number, member_name, loan_type, amount, balance,
          interest_rate, term, due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose,
          loan_mode, calculated_interest, total_repayment, in_kind_items, co_maker_name, co_maker_address, co_maker_contact,
          co_maker_relationship, collateral_type, collateral_details)
         VALUES ('L-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-' || LPAD(nextval('loans_id_seq')::text, 3, '0'), $1, $2, $3, $4, $5,
          $6, $7, $8, $9, CURRENT_DATE + make_interval(months => $9::int), CURRENT_DATE + INTERVAL '1 month', $10, $11, $12,
          $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, $23)`,
        [request.id, request.member_id, request.member_number, request.member_name, request.loan_type.toLowerCase(), request.amount,
          totalRepayment, interestRate, request.term, monthlyPayment, request.farm_area, request.maximum_eligible_amount,
          request.purpose, request.loan_mode, calculatedInterest, totalRepayment, JSON.stringify(request.in_kind_items || []),
          request.co_maker_name, request.co_maker_address, request.co_maker_contact, request.co_maker_relationship,
          request.collateral_type, request.collateral_details]
      );
    }
    await client.query('COMMIT');
    const memberResult = await query(`SELECT u.id AS user_id, u.email AS user_email, m.email AS member_email FROM members m LEFT JOIN users u ON u.member_id = m.id WHERE m.id = $1`, [request.member_id]);
    const recipient = memberResult.rows[0]?.user_email || memberResult.rows[0]?.member_email;
    if (recipient) {
      const email = loanDecisionEmail({ memberName: request.member_name, requestId: request.id, amount: request.amount, interestRate: request.interest_rate ?? (status === 'approved' ? 8 : undefined), term: request.term, status, reviewedAt: new Date(), reason: request.rejection_reason });
      void sendEmailSafely({ ...email, to: recipient, notificationType: status === 'approved' ? 'loan_approved' : 'loan_declined', dedupeKey: String(request.id), relatedUserId: memberResult.rows[0]?.user_id, relatedMemberId: request.member_id });
    }
    await createAuditLog({
      user: req.user,
      action: status === 'approved' ? 'LOAN_APPROVED' : 'LOAN_REJECTED',
      module: 'Loans',
      entityType: 'loan_request',
      entityId: String(request.id),
      description: `Loan request ${status} for ${request.member_name}`,
      oldValues: { status: request.status },
      newValues: { status },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    return res.json({ message: `Loan request ${status}.` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Review loan request error:', error);
    return res.status(500).json({ message: 'Unable to review loan request.' });
  } finally { client.release(); }
}

export async function recordPayment(req, res) {
  const client = await getPool().connect();
  try {
    const rawAmount = Number(req.body?.amount);
    const paymentDate = req.body?.paymentDate;
    if (!Number.isFinite(rawAmount) || rawAmount <= 0 || !paymentDate) return res.status(400).json({ message: 'A valid amount and payment date are required.' });
    const amountCents = Math.round(rawAmount * 100);
    const amount = amountCents / 100;
    if (amountCents <= 0) return res.status(400).json({ message: 'A valid amount and payment date are required.' });
    await client.query('BEGIN');
    const loanResult = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    const loan = loanResult.rows[0];
    if (!loan) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Loan not found.' });
    }
    const balanceCents = Math.round(Number(loan.balance) * 100);
    if (loan.status === 'paid' || amountCents > balanceCents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Payment cannot exceed the outstanding balance.' });
    }
    const totalInterest = Number((Number(loan.amount) * Number(loan.interest_rate) / 100).toFixed(2));
    const paidInterestResult = await client.query('SELECT COALESCE(SUM(interest_paid), 0) AS paid_interest, COUNT(*)::integer AS payment_count FROM loan_payments WHERE loan_id = $1', [loan.id]);
     const unpaidInterest = Math.max(0, Number((totalInterest - Number(paidInterestResult.rows[0].paid_interest)).toFixed(2)));
    const remainingInstallments = Math.max(1, Number(loan.term) - Number(paidInterestResult.rows[0].payment_count));
    const scheduledInterest = Number((totalInterest / Number(loan.term)).toFixed(2));
    const interestPaid = Math.min(amount, unpaidInterest, remainingInstallments === 1 ? unpaidInterest : scheduledInterest);
     const principalPaid = Number((amount - interestPaid).toFixed(2));
    const remaining = (balanceCents - amountCents) / 100;
    const payment = await client.query(
      `INSERT INTO loan_payments (loan_id, amount, payment_date, principal_paid, interest_paid, remaining_balance, recorded_by)
       VALUES ($1::integer, $2::numeric, $3::date, $6::numeric, $7::numeric, $4::numeric, $5::integer) RETURNING id`, [loan.id, amount, paymentDate, remaining, req.user.user_id, principalPaid, interestPaid]
    );
     await client.query(`UPDATE loans SET balance = $1::numeric, status = $2, next_payment_date = CASE WHEN $1::numeric = 0::numeric THEN NULL ELSE CURRENT_DATE + INTERVAL '1 month' END, updated_at = NOW() WHERE id = $3::integer`, [remaining, remaining === 0 ? 'paid' : loan.status, loan.id]);
    await client.query('COMMIT');
    await createAuditLog({
      user: req.user,
      action: 'PAYMENT_CREATED',
      module: 'Payments',
      entityType: 'loan_payment',
      entityId: String(payment.rows[0].id),
      description: `Recorded payment for loan ${loan.loan_number}`,
      oldValues: { balance: Number(loan.balance), status: loan.status },
      newValues: { balance: remaining, status: remaining === 0 ? 'paid' : loan.status, amount, payment_date: paymentDate },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });
    const result = await query(`SELECT p.id, p.loan_id AS "loanId", l.loan_number AS "loanNumber", l.member_id AS "memberId", l.member_name AS "memberName", COALESCE(u.email, m.email) AS "memberEmail", p.amount, p.payment_date AS "paymentDate", p.principal_paid AS "principalPaid", p.interest_paid AS "interestPaid", p.remaining_balance AS "remainingBalance" FROM loan_payments p JOIN loans l ON l.id = p.loan_id LEFT JOIN members m ON m.id = l.member_id LEFT JOIN users u ON u.member_id = m.id WHERE p.id = $1`, [payment.rows[0].id]);
    const paymentRow = result.rows[0];
    if (paymentRow.memberEmail) {
      const email = paymentEmail({ memberName: paymentRow.memberName, amount: paymentRow.amount, paymentDate: paymentRow.paymentDate, loanNumber: paymentRow.loanNumber, remainingBalance: paymentRow.remainingBalance, status: remaining === 0 ? 'paid' : 'recorded' });
      void sendEmailSafely({ ...email, to: paymentRow.memberEmail, notificationType: 'payment_recorded', dedupeKey: String(paymentRow.id), relatedMemberId: paymentRow.memberId, relatedLoanId: paymentRow.loanId });
    }
    return res.status(201).json({ payment: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Record payment error:', error);
    return res.status(500).json({ message: 'Unable to record payment.' });
  } finally { client.release(); }
}

export async function createMemberLoanRequest(req, res) {
  try {
    const memberId = Number(req.user?.member_id);
    if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ message: 'A valid member account is required.' });
    const memberResult = await query(memberApplicationSelect, [memberId]);
    const member = memberResult.rows[0];
    if (!member) return res.status(400).json({ message: 'Your active member record could not be found.' });
    const application = await prepareApplication(req.body || {}, member);
    const income = req.body?.monthlyIncome === '' || req.body?.monthlyIncome === undefined ? '0' : readDecimal(req.body.monthlyIncome, 'Monthly income');

    const request = await query(
      `INSERT INTO loan_requests (member_id, member_number, member_name, loan_type, amount, term, purpose, monthly_income,
        borrower_email, borrower_phone, borrower_address, borrower_age, borrower_gender, borrower_civil_status, borrower_occupation,
        years_farming, farm_location, barangay, municipality, province, farm_area, crops_planted, crop_season, irrigation_type,
        irrigation_other, loan_mode, maximum_eligible_amount, interest_rate, calculated_interest, total_repayment, in_kind_items,
        co_maker_name, co_maker_address, co_maker_contact, co_maker_relationship, collateral_type, collateral_details)
       VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15, $16::numeric, $17, $18, $19, $20,
         $21::numeric, $22, $23, $24, $25, $26, $27::numeric, $28::numeric, $29::numeric, $30::numeric, $31::jsonb, $32, $33, $34, $35, $36, $37)
       RETURNING id, member_id AS "memberId", member_name AS "memberName", loan_type AS "loanType",
                 amount, term, purpose, monthly_income AS "monthlyIncome", farm_area AS "farmArea",
                 maximum_eligible_amount AS "maximumEligibleAmount", interest_rate AS "interestRate",
                 calculated_interest AS "calculatedInterest", total_repayment AS "totalRepayment",
                 submitted_at AS "submittedAt", status`,
      [member.id, member.member_number, member.full_name, application.loanType, application.requestedAmount, application.term,
        application.purpose, income, application.borrowerEmail, application.borrowerPhone, application.borrowerAddress,
        application.borrowerAge, application.borrowerGender, application.borrowerCivilStatus, application.borrowerOccupation,
        application.yearsFarming, application.farmLocation, application.barangay, application.municipality, application.province,
        application.farmArea, application.cropsPlanted, application.cropSeason, application.irrigationType, application.irrigationOther,
        application.loanMode, application.financials.maximum_eligible_amount, DEFAULT_INTEREST_RATE,
        application.financials.calculated_interest, application.financials.total_repayment, JSON.stringify(application.inKindItems),
        application.coMaker.name, application.coMaker.address, application.coMaker.contact, application.coMaker.relationship,
        application.collateralType, application.collateralDetails]
    );

    void notifyAdminsAboutLoan(request.rows[0]).catch((error) => console.error('Loan submission email notification failed:', error instanceof Error ? error.message : error));

    return res.status(201).json({ request: request.rows[0] });
  } catch (error) {
    console.error('Create member loan request error:', error);
    if (error.code === '23505') return res.status(409).json({ message: 'You already have a pending application for this loan type.' });
    return res.status(error.message ? 400 : 500).json({ message: error.message || 'Unable to submit your loan application.' });
  }
}
