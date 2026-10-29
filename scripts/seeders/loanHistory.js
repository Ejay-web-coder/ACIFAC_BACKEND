import { SQL_TODAY, TIME_ZONE } from '../../src/config/env.js';
import { LOAN_POLICY } from '../../src/services/loanService.js';
import { paymentHours } from '../../src/services/officeHours.js';
import { centsToString } from '../../src/utils/money.js';
import { addDays, addMonths, officeDayOnOrBefore } from './support.js';

// A year and more of loans for the generated members (the named ones get
// theirs in loans.js): loans paid off (on time, early or late), loans not due
// yet, overdue loans, second loans of members who paid off the first,
// applications waiting for a decision and declined ones. The loans follow the
// Loans page's policy (at most farm area x PHP 50,000, 2.5% flat interest, 6
// months, one payment of the whole amount due 6 months after approval on an
// office day) and are paid in full at once, as the Payments page requires.
// Everything is written a statement at a time for all loans together: per
// loan through the app's helpers it would take minutes across the internet.
//   pattern: [kind, months ago approved or days ago submitted, how it is paid]
const TERM = LOAN_POLICY.loanTerm;
const PATTERNS = [
  ['paid', 13, 'on time'], ['paid', 11, 'late'], ['active', 4], ['active', 2], ['overdue', 8],
  ['paid', 9, 'early'], ['active', 5], ['pending', 4], ['active', 1], ['declined', 35],
  ['paid', 14, 'on time'], ['active', 3], ['overdue', 7], ['paid', 7, 'on time'], ['pending', 9],
];
const PURPOSES = {
  agricultural: ['Seeds and fertilizer for the wet season rice crop.', 'Land preparation and hired labor for the coming planting.', 'Fertilizer and pesticide for the dry season crop.',
    'Certified palay seeds and fertilizer.', 'Hybrid corn seeds and fertilizer.'],
};
const DECLINE_REASONS = ['The member has an unpaid balance with the cooperative.', 'The requested amount is more than the farm area allows this season.'];
const RELATIONS = ['Brother', 'Sister', 'Cousin', 'Neighbor', 'Spouse'];
const stamp = (dayParam, time) => `((${dayParam})::date + TIME '${time}') AT TIME ZONE '${TIME_ZONE}'`;

// The loan of a member, from the pattern: amount, type, dates and how it is paid.
function planFor(member, n, today) {
  const [kind, ago, paying] = PATTERNS[n % PATTERNS.length];
  const eligibleCents = Math.round(Number(member.farmArea) * Number(LOAN_POLICY.maxLoanPerHectare) * 100);
  // ACIFAC gives agricultural loans only.
  const type = 'agricultural';
  const share = [0.5, 0.6, 0.8, 0.4, 0.7][n % 5];
  const amountCents = Math.max(500000, Math.min(eligibleCents, Math.floor((eligibleCents * share) / 500000) * 500000));
  const submittedOn = kind === 'pending' || kind === 'declined' ? addDays(today, -ago) : addDays(officeDayOnOrBefore(addMonths(today, -ago)), -4);
  if (submittedOn < addDays(member.membershipDate, 30)) return null;
  return {
    member, kind, type, term: TERM, paying, amountCents, submittedOn,
    approvedOn: kind === 'pending' || kind === 'declined' ? null : officeDayOnOrBefore(addMonths(today, -ago)),
    purpose: PURPOSES[type][n % PURPOSES[type].length],
  };
}

export default async function seedLoanHistory(ctx) {
  const { client, today, admin } = ctx;
  const generated = ctx.members.slice(15).filter((member, index) => index % 2 === 0 || index % 9 === 1);
  const plans = generated.map((member, n) => planFor(member, n, today)).filter(Boolean);
  // Members who paid off their first loan come back for a second one.
  for (const [n, first] of plans.filter((plan) => plan.kind === 'paid').entries()) {
    if (n % 2) continue;
    const again = planFor(first.member, 2 + (n % 3) * 5, today);
    if (again && again.kind === 'active' && again.submittedOn > addMonths(first.approvedOn, TERM)) plans.push(again);
  }
  if (!plans.length) return;

  // Applications, with the borrower's details as the application form takes them.
  const interestCents = (plan) => Math.round((plan.amountCents * Number(LOAN_POLICY.interestRate)) / 100);
  const column = (pick) => plans.map(pick);
  const age = (born, on) => Number(on.slice(0, 4)) - Number(born.slice(0, 4)) - (on.slice(5) < born.slice(5) ? 1 : 0);
  const requestIds = (await client.query(
    `INSERT INTO loan_requests (member_id, member_number, member_name, loan_type, amount, term, purpose, monthly_income, borrower_email, borrower_phone, borrower_address,
       borrower_age, borrower_gender, borrower_civil_status, borrower_occupation, years_farming, farm_location, barangay, municipality, province, farm_area,
       crops_planted, crop_season, irrigation_type, loan_mode, maximum_eligible_amount, interest_rate, calculated_interest, total_repayment, in_kind_items,
       co_maker_name, co_maker_address, co_maker_contact, co_maker_relationship, collateral_type, collateral_details, id_documents,
       status, review_notes, submitted_at, reviewed_at, reviewed_by, updated_at)
     SELECT r.member_id, r.member_number, r.member_name, r.loan_type, r.amount, r.term, r.purpose, r.income, r.email, r.phone, r.address,
            r.age, r.gender, r.civil, r.occupation, r.years, r.barangay || ', Santa Cruz', r.barangay, 'Santa Cruz', 'Occidental Mindoro', r.farm_area,
            r.crop, r.season, 'irrigated', 'cash', r.eligible, $27::numeric, r.interest, r.total, '[]'::jsonb,
            r.co_name, r.co_address, r.co_contact, r.co_relation, r.collateral, r.collateral_details, '{}'::jsonb,
            r.status, NULL, ${stamp('r.submitted', '09:30')}, CASE WHEN r.reviewed IS NULL THEN NULL ELSE ${stamp('r.reviewed', '15:00')} END,
            CASE WHEN r.reviewed IS NULL THEN NULL ELSE $28::int END, ${stamp('COALESCE(r.reviewed, r.submitted)', '15:00')}
     FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::int[], $7::text[], $8::numeric[], $9::text[], $10::text[], $11::text[],
                 $12::int[], $13::text[], $14::text[], $15::text[], $16::int[], $17::text[], $18::numeric[], $19::text[], $20::text[], $21::numeric[],
                 $22::numeric[], $23::numeric[], $24::text[], $25::text[], $26::text[], $29::text[], $30::text[], $31::text[], $32::text[], $33::date[], $34::date[])
          WITH ORDINALITY AS r(member_id, member_number, member_name, loan_type, amount, term, purpose, income, email, phone, address,
               age, gender, civil, occupation, years, barangay, farm_area, crop, season, eligible,
               interest, total, co_name, co_address, co_contact, co_relation, collateral, collateral_details, status, submitted, reviewed, ord)
     ORDER BY r.ord
     RETURNING id`,
    [column((p) => p.member.id), column((p) => p.member.memberNumber), column((p) => p.member.fullName), column((p) => p.type), column((p) => centsToString(p.amountCents)),
      column((p) => p.term), column((p) => p.purpose), column((p, i) => String(6000 + (i % 8) * 1500)), column((p) => p.member.email), column((p) => p.member.phone),
      column((p) => p.member.address), column((p) => age(p.member.born, p.submittedOn)), column((p) => p.member.gender), column((p) => p.member.civilStatus),
      column(() => 'Farmer'), column((p, i) => 3 + (i % 25)), column((p) => p.member.barangay), column((p) => p.member.farmArea),
      column((p) => p.member.crop), column((p) => `${Number(p.submittedOn.slice(5, 7)) >= 5 && Number(p.submittedOn.slice(5, 7)) <= 10 ? 'Wet' : 'Dry'} season ${p.submittedOn.slice(0, 4)}`),
      column((p) => centsToString(Math.round(Number(p.member.farmArea) * Number(LOAN_POLICY.maxLoanPerHectare) * 100))),
      column((p) => centsToString(interestCents(p))), column((p) => centsToString(p.amountCents + interestCents(p))),
      column((p, i) => `${['Ramon', 'Nida', 'Celso', 'Luz', 'Dante'][i % 5]} ${p.member.fullName.split(' ').at(-1)}`), column((p) => p.member.address),
      column((p, i) => `0900 003 ${String(i + 1).padStart(4, '0')}`), LOAN_POLICY.interestRate, admin.id,
      column((p, i) => RELATIONS[i % RELATIONS.length]), column((p, i) => (i % 3 === 0 ? 'Harvest' : i % 3 === 1 ? 'Savings Deposit / Share Capital' : 'Land Title / Property')),
      column((p, i) => (i % 3 === 0 ? 'Next palay harvest' : i % 3 === 1 ? 'Savings and share capital with the cooperative' : `Tax declaration of farm lot, ${p.member.barangay}`)),
      column((p) => (p.kind === 'pending' ? 'pending' : p.kind === 'declined' ? 'declined' : 'approved')), column((p) => p.submittedOn),
      column((p) => (p.kind === 'pending' ? null : p.kind === 'declined' ? addDays(p.submittedOn, 3) : p.approvedOn))]
  )).rows.map((row) => row.id);
  plans.forEach((plan, index) => { plan.requestId = requestIds[index]; });
  const declined = plans.filter((plan) => plan.kind === 'declined');
  if (declined.length) {
    await client.query(`UPDATE loan_requests SET review_notes = r.note FROM unnest($1::int[], $2::text[]) AS r(id, note) WHERE loan_requests.id = r.id`,
      [declined.map((plan) => plan.requestId), declined.map((plan, i) => DECLINE_REASONS[i % DECLINE_REASONS.length])]);
  }
  ctx.count('loan applications', plans.length);

  // The loans of the approved applications, numbered L-YYYY-### by the year approved.
  const loans = plans.filter((plan) => plan.approvedOn);
  const lc = (pick) => loans.map(pick);
  const loanIds = (await client.query(
    `INSERT INTO loans (loan_number, loan_request_id, member_id, member_number, member_name, loan_type, amount, balance, interest_rate, term,
       date_approved, due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose, loan_mode,
       calculated_interest, total_repayment, created_at, updated_at)
     SELECT 'L-TMP-' || r.ord, r.request_id, r.member_id, r.member_number, r.member_name, r.loan_type, r.amount, r.total, $13::numeric, r.term,
            r.approved, r.approved + make_interval(months => r.term), r.approved + make_interval(months => r.term), r.total, r.farm_area,
            ROUND(r.farm_area * $14::numeric, 2), r.purpose, 'cash', r.interest, r.total, ${stamp('r.approved', '15:00')}, ${stamp('r.approved', '15:00')}
     FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::int[], $9::date[], $10::numeric[], $11::text[], $12::numeric[])
          WITH ORDINALITY AS r(request_id, member_id, member_number, member_name, loan_type, amount, total, term, approved, farm_area, purpose, interest, ord)
     ORDER BY r.ord
     RETURNING id`,
    [lc((p) => p.requestId), lc((p) => p.member.id), lc((p) => p.member.memberNumber), lc((p) => p.member.fullName), lc((p) => p.type),
      lc((p) => centsToString(p.amountCents)), lc((p) => centsToString(p.amountCents + interestCents(p))), lc((p) => p.term), lc((p) => p.approvedOn),
      lc((p) => p.member.farmArea), lc((p) => p.purpose), lc((p) => centsToString(interestCents(p))), LOAN_POLICY.interestRate, LOAN_POLICY.maxLoanPerHectare]
  )).rows.map((row) => row.id);
  loans.forEach((plan, index) => { plan.loanId = loanIds[index]; });
  await client.query(`UPDATE loans SET loan_number = 'L-' || TO_CHAR(date_approved, 'YYYY') || '-' || LPAD(id::text, 3, '0') WHERE id = ANY($1::int[])`, [loanIds]);

  // The schedule: one installment of the whole amount per loan, due TERM months
  // after approval on an office day (loanService's insertSchedule for a single-payment loan).
  await client.query(
    `WITH base AS (
       SELECT * FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::int[], $5::date[]) AS b(loan_id, total, interest, term, start)
     )
     INSERT INTO loan_installments (loan_id, installment_number, due_date, amount_due, principal_due, interest_due)
     SELECT loan_id, 1, due.day, total, GREATEST(total - interest, 0), LEAST(interest, total)
     FROM base
     CROSS JOIN LATERAL (
       SELECT ((start + make_interval(months => term))::date + k) AS day
       FROM generate_series(0, 6) AS k
       WHERE EXTRACT(ISODOW FROM (start + make_interval(months => term))::date + k)::int = ANY($6::int[])
       ORDER BY k LIMIT 1
     ) due`,
    [loanIds, lc((p) => centsToString(p.amountCents + interestCents(p))), lc((p) => centsToString(interestCents(p))), lc((p) => p.term), lc((p) => p.approvedOn), paymentHours().days]
  );
  await client.query(
    `UPDATE loans l SET due_date = last.due_date
     FROM (SELECT loan_id, MAX(due_date) AS due_date FROM loan_installments WHERE loan_id = ANY($1::int[]) GROUP BY loan_id) last WHERE l.id = last.loan_id`,
    [loanIds]
  );

  // Payments: the whole amount at once, on time (two days before the due date),
  // early (half-way through the term) or late (twelve days after); active and
  // overdue loans are not paid yet.
  const installments = (await client.query(
    `SELECT id, loan_id, installment_number, due_date::text AS due_date, amount_due, principal_due, interest_due
     FROM loan_installments WHERE loan_id = ANY($1::int[]) ORDER BY loan_id, installment_number`, [loanIds]
  )).rows;
  const payments = [];
  for (const plan of loans) {
    if (plan.kind !== 'paid') continue;
    const row = installments.find((installment) => installment.loan_id === plan.loanId);
    const due = row.due_date;
    let paidOn = officeDayOnOrBefore(plan.paying === 'late' ? addDays(due, 12) : plan.paying === 'early' ? addMonths(plan.approvedOn, Math.floor(TERM / 2)) : addDays(due, -2));
    if (paidOn < plan.approvedOn) paidOn = plan.approvedOn;
    if (paidOn > today) continue;
    payments.push({ loanId: plan.loanId, installmentId: row.id, amount: row.amount_due, principal: row.principal_due, interest: row.interest_due, date: paidOn, remaining: '0.00' });
  }
  if (payments.length) {
    const pc = (pick) => payments.map(pick);
    await client.query(
      `INSERT INTO loan_payments (loan_id, amount, payment_date, principal_paid, interest_paid, remaining_balance, recorded_by, created_at)
       SELECT r.loan_id, r.amount, r.day, r.principal, r.interest, r.remaining, $7, ${stamp('r.day', '10:30')}
       FROM unnest($1::int[], $2::numeric[], $3::date[], $4::numeric[], $5::numeric[], $6::numeric[]) AS r(loan_id, amount, day, principal, interest, remaining)`,
      [pc((p) => p.loanId), pc((p) => p.amount), pc((p) => p.date), pc((p) => p.principal), pc((p) => p.interest), pc((p) => p.remaining), admin.id]
    );
    await client.query(
      `UPDATE loan_installments i SET amount_paid = i.amount_due, interest_paid = i.interest_due, principal_paid = i.principal_due,
              last_payment_date = r.day, paid_date = r.day, updated_at = NOW()
       FROM unnest($1::int[], $2::date[]) AS r(id, day) WHERE i.id = r.id`,
      [pc((p) => p.installmentId), pc((p) => p.date)]
    );
    ctx.count('loan payments', payments.length);
  }

  // Balance, next payment and status, as loanService's recomputeLoanState works them out.
  await client.query(
    `WITH totals AS (
       SELECT l.id,
              COALESCE(l.total_repayment, ROUND(l.amount + ROUND(l.amount * l.interest_rate / 100, 2), 2)) AS total,
              COALESCE((SELECT SUM(p.amount) FROM loan_payments p WHERE p.loan_id = l.id), 0) AS paid,
              (SELECT MIN(i.due_date) FROM loan_installments i WHERE i.loan_id = l.id AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL) AS next_due,
              EXISTS (SELECT 1 FROM loan_installments i WHERE i.loan_id = l.id AND i.amount_paid < i.amount_due AND i.superseded_by IS NULL AND i.due_date < ${SQL_TODAY}) AS overdue
       FROM loans l WHERE l.id = ANY($1::int[])
     )
     UPDATE loans l
     SET balance = GREATEST(t.total - t.paid, 0),
         next_payment_date = CASE WHEN t.total - t.paid <= 0 THEN NULL ELSE t.next_due END,
         status = CASE WHEN t.total - t.paid <= 0 THEN 'paid' WHEN t.overdue THEN 'overdue' ELSE 'active' END,
         updated_at = NOW()
     FROM totals t WHERE l.id = t.id`,
    [loanIds]
  );
  ctx.count('loans', loans.length);

  // The activity log: each application, and the approval of each loan.
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, new_values, user_agent, created_at)
     SELECT $1, $2, $3, 'LOAN_APPLICATION_SUBMITTED', 'Loans', 'loan_request', r.id::text, 'Loan application submitted by ' || r.name,
            jsonb_build_object('amount', r.amount, 'loan_type', r.loan_type), $4, ${stamp('r.day', '09:30')}
     FROM unnest($5::int[], $6::text[], $7::numeric[], $8::text[], $9::date[]) AS r(id, name, amount, loan_type, day)`,
    [admin.id, admin.username, admin.role, ctx.req.headers['user-agent'], column((p) => p.requestId), column((p) => p.member.fullName),
      column((p) => centsToString(p.amountCents)), column((p) => p.type), column((p) => p.submittedOn)]
  );
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, new_values, user_agent, created_at)
     SELECT $1, $2, $3, 'LOAN_APPROVED', 'Loans', 'loan', r.id::text, 'Approved loan for ' || r.name,
            jsonb_build_object('amount', r.amount, 'term', r.term), $4, ${stamp('r.day', '15:00')}
     FROM unnest($5::int[], $6::text[], $7::numeric[], $8::int[], $9::date[]) AS r(id, name, amount, term, day)`,
    [admin.id, admin.username, admin.role, ctx.req.headers['user-agent'], loanIds, lc((p) => p.member.fullName), lc((p) => centsToString(p.amountCents)),
      lc((p) => p.term), lc((p) => p.approvedOn)]
  );
}
