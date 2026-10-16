import { insertLoanRequest, memberApplicationSelect, prepareApplication } from '../../src/controllers/loanController.js';
import { allocatePayment, createInstallments, LOAN_POLICY, recomputeLoanState } from '../../src/services/loanService.js';
import { centsToString, toCents } from '../../src/utils/money.js';
import { addDays, addMonths, officeDayOnOrBefore, stampSql } from './support.js';

// Loan applications and loans. Each goes through the application code of the
// Loans page (eligibility = farm area x PHP 50,000, 2.5% flat interest), is
// approved `approved` months ago, gets its monthly installment schedule, and
// its installments are paid as `paid` says, oldest first:
//   'on time' = paid two days before the due date, 'late' = 12 days after,
//   and an installment not listed (or not yet reached) stays unpaid.
// Loans whose unpaid installments are past due become overdue on their own.
const LOANS = [
  { key: 'juan', type: 'agricultural', amount: '60000', term: 6, approved: 7, paid: Array(6).fill('on time'), purpose: 'Seeds, fertilizer and land preparation for the wet season rice crop.' },
  { key: 'maria', type: 'agricultural', amount: '50000', term: 10, approved: 5, paid: Array(5).fill('on time'), purpose: 'Certified palay seeds and fertilizer.' },
  { key: 'pedro', type: 'agricultural', amount: '40000', term: 6, approved: 5, paid: ['on time', 'late'], purpose: 'Fertilizer and pesticide for 1.5 ha of rice.' },
  { key: 'rosario', type: 'personal', amount: '20000', term: 12, approved: 4, paid: ['late', 'late', 'on time'], purpose: 'Repair of the house roof.' },
  { key: 'antonio', type: 'agricultural', amount: '75000', term: 8, approved: 2, paid: ['on time', 'on time'], purpose: 'Hired labor and fertilizer for 2 ha of rice.' },
  { key: 'ricardo', type: 'emergency', amount: '10000', term: 4, approved: 1, paid: [], purpose: 'Hospital bills.' },
];
// Applications still waiting for a decision, and one declined.
const APPLICATIONS = [
  { key: 'elena', type: 'agricultural', amount: '30000', term: 6, daysAgo: 3, purpose: 'Fertilizer for the coming planting.' },
  { key: 'ernesto', type: 'agricultural', amount: '45000', term: 8, daysAgo: 1, purpose: 'Land preparation and seeds for 1.4 ha.' },
  { key: 'danilo', type: 'personal', amount: '15000', term: 6, daysAgo: 20, purpose: 'Motorcycle repair.', declined: 'The member has been with the cooperative for less than a year.' },
];

async function applyFor(ctx, plan, submittedOn) {
  const { client, req } = ctx;
  const member = (await client.query(memberApplicationSelect, [ctx.member(plan.key).id])).rows[0];
  const application = await prepareApplication(client, {
    loanType: plan.type, loanMode: 'cash', amount: plan.amount, term: plan.term, purpose: plan.purpose,
    farmArea: member.farm_area_ha, cropsPlanted: 'Rice', cropSeason: `Wet season ${submittedOn.slice(0, 4)}`, irrigationType: 'irrigated',
  }, member);
  const request = await insertLoanRequest(client, req, { member, application, income: '12000', submittedBy: 'office' });
  await client.query(`UPDATE loan_requests SET submitted_at = ${stampSql('$2')}, updated_at = ${stampSql('$2')} WHERE id = $1`, [request.id, submittedOn]);
  ctx.count('loan applications');
  return { requestId: request.id, member, application };
}

// The loan of an approved application, as the approval does, but approved on `approvedOn`.
async function approve(ctx, { requestId, member, application }, approvedOn) {
  const { client } = ctx;
  const { financials } = application;
  const loanId = (await client.query(
    `INSERT INTO loans (loan_number, loan_request_id, member_id, member_number, member_name, loan_type, amount, balance, interest_rate, term,
       date_approved, due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose, loan_mode,
       calculated_interest, total_repayment, created_at, updated_at)
     VALUES ('L-TMP-' || left(md5(random()::text), 20), $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9,
       $10::date, $10::date + make_interval(months => $9::int), $10::date + INTERVAL '1 month', $11::numeric, $12::numeric, $13::numeric, $14, 'cash',
       $15::numeric, $7::numeric, ${stampSql('$10', '15:00')}, ${stampSql('$10', '15:00')})
     RETURNING id`,
    [requestId, member.id, member.member_number, member.full_name, application.loanType, application.requestedAmount, financials.total_repayment,
      LOAN_POLICY.interestRate, application.term, approvedOn, financials.monthly_payment, application.farmArea, financials.maximum_eligible_amount,
      application.purpose, financials.calculated_interest]
  )).rows[0].id;
  // L-YYYY-### like the Loans page, the year being the year of approval.
  await client.query(`UPDATE loans SET loan_number = 'L-' || TO_CHAR(date_approved, 'YYYY') || '-' || LPAD(id::text, 3, '0') WHERE id = $1`, [loanId]);
  await createInstallments(client, loanId);
  await recomputeLoanState(client, loanId);
  await client.query(
    `UPDATE loan_requests SET status = 'approved', reviewed_at = ${stampSql('$2', '15:00')}, reviewed_by = $3, updated_at = ${stampSql('$2', '15:00')} WHERE id = $1`,
    [requestId, approvedOn, ctx.admin.id]
  );
  ctx.count('loans');
  return loanId;
}

// Records a payment as the Payments page does: applied to the oldest unpaid installment, interest first.
async function pay(ctx, loanId, amount, paymentDate) {
  const { client } = ctx;
  const before = await recomputeLoanState(client, loanId);
  const amountCents = Math.min(toCents(amount), toCents(before.balance));
  const allocation = await allocatePayment(client, loanId, amountCents, paymentDate);
  await client.query(
    `INSERT INTO loan_payments (loan_id, amount, payment_date, principal_paid, interest_paid, remaining_balance, recorded_by, created_at)
     VALUES ($1, $2::numeric, $3::date, $4::numeric, $5::numeric, $6::numeric, $7, ${stampSql('$3', '10:30')})`,
    [loanId, centsToString(amountCents), paymentDate, centsToString(allocation.principalCents), centsToString(allocation.interestCents),
      centsToString(toCents(before.balance) - amountCents), ctx.admin.id]
  );
  await recomputeLoanState(client, loanId);
  ctx.count('loan payments');
}

export default async function seedLoans(ctx) {
  const { client, today } = ctx;
  for (const plan of LOANS) {
    const approvedOn = officeDayOnOrBefore(addMonths(today, -plan.approved));
    const loanId = await approve(ctx, await applyFor(ctx, plan, addDays(approvedOn, -4)), approvedOn);
    const installments = (await client.query(
      'SELECT installment_number, due_date, amount_due FROM loan_installments WHERE loan_id = $1 ORDER BY installment_number', [loanId]
    )).rows;
    for (const [index, when] of plan.paid.entries()) {
      const installment = installments[index];
      if (!installment) break;
      const paidOn = officeDayOnOrBefore(addDays(installment.due_date, when === 'late' ? 12 : -2));
      if (paidOn > today) break;
      await pay(ctx, loanId, installment.amount_due, paidOn < approvedOn ? approvedOn : paidOn);
    }
  }
  for (const plan of APPLICATIONS) {
    const submittedOn = addDays(today, -plan.daysAgo);
    const { requestId } = await applyFor(ctx, plan, submittedOn);
    if (plan.declined) {
      await client.query(
        `UPDATE loan_requests SET status = 'declined', review_notes = $2, reviewed_by = $3, reviewed_at = ${stampSql('$4', '16:00')}, updated_at = NOW() WHERE id = $1`,
        [requestId, plan.declined, ctx.admin.id, addDays(submittedOn, 2)]
      );
    }
  }
}
