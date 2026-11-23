import { TIME_ZONE } from '../../src/config/env.js';
import { insertLoanPayment, insertLoanRequest, memberApplicationSelect, prepareApplication } from '../../src/controllers/loanController.js';
import { shareCapitalRoomCents } from '../../src/controllers/memberController.js';
import { DUES, DUES_PAYMENT_METHOD, meetingDuesMessage } from '../../src/services/dues.js';
import { deductionsText, deductionValues, FIRST_LOAN_YEAR, recordLoanDeductions } from '../../src/services/loanDeductions.js';
import { createInstallments, LOAN_POLICY, penaltyDue, recomputeLoanState } from '../../src/services/loanService.js';
import { computeServiceFee, findRateForDate, rateForClient } from '../../src/services/machineryFees.js';
import { notifyMember } from '../../src/services/notificationService.js';
import { capitalChange, createAuditLog } from '../../src/utils/audit.js';
import { centsToString, toCents } from '../../src/utils/money.js';
import { addDays, addMonths, officeDayOnOrBefore, stampSql } from './support.js';
import { HISTORY_ACTION, MEMBER_SEEDER_AGENT } from './memberHistoryRemoval.js';

export { HISTORY_ACTION, MEMBER_SEEDER_AGENT, removeMemberHistory } from './memberHistoryRemoval.js';

// The history of ONE member who is already registered (a real member, not one
// of the sample members of `npm run seed`): the records the office would have
// entered for them over the last two years, from their membership date on, so
// their pages (profile, savings, share capital, loans, dues, attendance,
// machinery, Kadiwa patronage) look like a member who has been using the
// cooperative. Run by scripts/seed-member.js.
//
// Nothing about the member themself changes (name, address, farm area,
// membership date); only records are added, all of them in the past, and none
// that would send them a text or an email:
//  - share capital: a contribution every six months;
//  - savings: a deposit most months (more after the harvests), two withdrawals
//    that leave more than the PHP 500 maintaining balance;
//  - loans, through the Loans page's own code (application checks, schedule,
//    payments, late penalty): one paid off late two years ago, one paid on time
//    a year ago, and one released three weeks ago and not due yet, with the
//    deductions of the loan policy (savings, 2% Capital Build-Up, PCIC);
//    loans need a farm area, a contact number and an address on the record,
//    and none is added if the member already has a loan or application open;
//  - machinery: land preparation before each planting and the harvester at
//    each harvest, at the rates in force on the day, paid; one day rental;
//  - Kadiwa: two purchases a month on the store's daily sales of the last year;
//  - attendance at the finalized activities they have no record for, and the
//    dues of those meetings, paid at the office.
// Everything is entered as the administrator, dated on its own day, and the
// member's notifications about it come already read (and not sent to a phone).
// The ids of every row written are kept in one audit entry (HISTORY_ACTION),
// so removeMemberHistory can take exactly those rows out again.

const HISTORY_MONTHS = 24;
// Loans released from November 2026 on have the loan policy's deductions (migration 071); loans before had none.
const DEDUCTIONS_FROM = '2026-11-01';
const TERM = LOAN_POLICY.loanTerm;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;
const THIS_TRANSACTION = 'xmin = pg_current_xact_id()::xid';
// The member's rows of these tables written by the run (member_id), kept for removal.
const MEMBER_TABLES = ['loan_requests', 'loans', 'savings_transactions', 'share_contributions', 'machinery_services', 'rental_requests',
  'machinery_operations', 'kadiwa_sale_members', 'activity_attendance', 'member_dues', 'member_dues_payments'];

// [when, how it was repaid, share of what the farm area allows]: dry season loans, 6 months, one payment.
const LOANS = [
  { monthsAgo: 24, paying: 'late', share: 0.6, purpose: (crop) => `Seeds and fertilizer for the dry season ${crop} crop.` },
  { monthsAgo: 12, paying: 'on time', share: 0.7, purpose: (crop) => `Land preparation, seeds and fertilizer for the dry season ${crop} crop.` },
  { daysAgo: 21, paying: null, share: 0.8, purpose: (crop) => `Certified seeds and fertilizer for the dry season ${crop} crop.` },
];
// [months ago, PHP] share capital paid on top of what the member already has.
const CONTRIBUTIONS = [[21, '1000'], [15, '1000'], [9, '1500'], [3, '1000']];
// Savings: a deposit most months, more after a harvest (April-May, October-November); [months ago, PHP] withdrawals.
const HARVEST_MONTHS = new Set([4, 5, 10, 11]);
const WITHDRAWALS = [[8, '1500'], [2, '1000']];
const MAINTAINING_CENTS = 50000;
// One bag of fresh palay, as the machinery seeder prices it.
const BAG = { kgPerBag: '50', pricePerKg: '18' };
const MARKS = ['present', 'present', 'late', 'present', 'excused', 'present', 'present', 'late', 'present'];
const EXCUSES = ['Sick', 'Out of town'];
const PURCHASE_CENTS = [35000, 52000, 18000, 64000, 27500, 41000, 23000, 48500];

const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const later = (a, b) => (a > b ? a : b);
const dayOfMonth = (day, n) => `${day.slice(0, 8)}${String(n).padStart(2, '0')}`;
const minutesAfter = (clock, minutes) => {
  const total = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const tableExists = async (client, table) => Boolean((await client.query('SELECT to_regclass($1) AS t', [`public.${table}`])).rows[0].t);

/** The administrator as the app's helpers read a request, with this script's user agent in the audit log. */
export function memberSeederRequest(admin) {
  return { user: { ...admin, user_id: admin.id }, headers: { 'user-agent': MEMBER_SEEDER_AGENT }, ip: null };
}

const MEMBER_COLUMNS = `id, member_number, first_name, middle_name, last_name, suffix, status, email, phone, address, barangay,
  farm_area_ha, palay_area_ha, corn_area_ha, yearly_income, membership_date::text AS membership_date, share_capital,
  TRIM(CONCAT_WS(' ', first_name, middle_name, last_name, suffix)) AS full_name`;
const nameSql = (...parts) => `lower(regexp_replace(TRIM(CONCAT_WS(' ', ${parts.join(', ')})), '\\s+', ' ', 'g'))`;

/** Members whose member number or name (with or without the middle name) is `wanted`, ignoring case and extra spaces. */
export async function findMembers(client, wanted) {
  const text = String(wanted).trim().replace(/\s+/g, ' ');
  return (await client.query(
    `SELECT ${MEMBER_COLUMNS} FROM members
     WHERE lower(member_number) = lower($1)
        OR ${nameSql('first_name', 'middle_name', 'last_name', 'suffix')} = lower($1) OR ${nameSql('first_name', 'middle_name', 'last_name')} = lower($1)
        OR ${nameSql('first_name', 'last_name', 'suffix')} = lower($1) OR ${nameSql('first_name', 'last_name')} = lower($1)
     ORDER BY id`,
    [text]
  )).rows;
}

/** Members with any word of `wanted` in their name, for "did you mean". */
export async function similarMembers(client, wanted) {
  const words = String(wanted).trim().split(/\s+/).filter((word) => word.length >= 3).map((word) => `%${word}%`);
  if (!words.length) return [];
  return (await client.query(
    `SELECT ${MEMBER_COLUMNS} FROM members WHERE first_name ILIKE ANY($1) OR last_name ILIKE ANY($1) OR middle_name ILIKE ANY($1) ORDER BY last_name, first_name LIMIT 10`,
    [words]
  )).rows;
}

// Rows the app's helpers just wrote are stamped NOW() (the transaction's start):
// date them `day` at `time`, as if they had been entered then.
async function dateNewRows(ctx, day, time) {
  const at = stampSql('$1', time);
  await ctx.client.query(
    `WITH a AS (UPDATE audit_logs SET created_at = ${at} WHERE created_at = NOW() AND ${THIS_TRANSACTION} RETURNING 1),
          n AS (UPDATE notifications SET created_at = ${at} WHERE created_at = NOW() AND ${THIS_TRANSACTION} RETURNING 1),
          s AS (UPDATE savings_transactions SET created_at = ${at} WHERE member_id = $2 AND created_at = NOW() RETURNING 1),
          c AS (UPDATE share_contributions SET created_at = ${at}, updated_at = ${at} WHERE member_id = $2 AND created_at = NOW() RETURNING 1),
          p AS (UPDATE loan_payments SET created_at = ${at} WHERE created_at = NOW() AND loan_id IN (SELECT id FROM loans WHERE member_id = $2) RETURNING 1),
          r AS (UPDATE loan_requests SET submitted_at = CASE WHEN submitted_at = NOW() THEN ${at} ELSE submitted_at END, updated_at = ${at}
                WHERE member_id = $2 AND (submitted_at = NOW() OR updated_at = NOW()) RETURNING 1)
     SELECT 1`,
    [day, ctx.member.id]
  );
}

// ---------------------------------------------------------------- loans

async function seedLoans(ctx) {
  const { client, member, today, req, admin } = ctx;
  const borrower = (await client.query(memberApplicationSelect, [member.id])).rows[0];
  const farmArea = Number(member.farm_area_ha || 0);
  const reason = !borrower ? 'the member is not active'
    : !(farmArea > 0) ? 'the member has no farm area on record (a loan is at most PHP 50,000 a hectare)'
      : !PHONE_PATTERN.test(borrower.phone || '') ? 'the member has no valid contact number on record (the loan application needs one)'
        : !borrower.address ? 'the member has no address on record (the loan application needs one)' : null;
  if (reason) return ctx.skipped(`loans: ${reason}`);
  const existing = (await client.query(
    `SELECT l.date_approved AS approved, l.status, (SELECT MAX(p.payment_date) FROM loan_payments p WHERE p.loan_id = l.id) AS last_paid FROM loans l WHERE l.member_id = $1`,
    [member.id]
  )).rows;
  const pending = (await client.query(`SELECT 1 FROM loan_requests WHERE member_id = $1 AND status = 'pending' LIMIT 1`, [member.id])).rows.length > 0;
  if (pending || existing.some((loan) => loan.status !== 'paid')) return ctx.skipped('loans: the member already has a loan or a loan application open');

  // The months each loan ran, so a new one never overlaps a loan the member already had.
  const taken = existing.map((loan) => [loan.approved, loan.last_paid ?? today]);
  let firstLoanOn = existing.map((loan) => loan.approved).sort()[0] ?? null;
  const income = Number(member.yearly_income) > 0 ? String(Math.round(Number(member.yearly_income) / 12)) : '12000';
  for (const plan of LOANS) {
    const approvedOn = officeDayOnOrBefore(plan.daysAgo ? addDays(today, -plan.daysAgo) : addMonths(today, -plan.monthsAgo));
    const submittedOn = officeDayOnOrBefore(addDays(approvedOn, -4));
    const which = `loan of ${approvedOn}`;
    // A member applies a month after joining at the earliest.
    if (submittedOn < addDays(member.membership_date, 30)) { ctx.skipped(`${which}: before the member's first month`); continue; }
    const until = plan.paying ? addDays(addMonths(approvedOn, TERM), 20) : '9999-12-31';
    if (plan.paying && until >= today) continue;
    if (taken.some(([from, to]) => from <= until && to >= submittedOn)) { ctx.skipped(`${which}: the member had another loan then`); continue; }
    // Loan policy rule 2: at most 2 hectares in the member's first year of loans, counted from their first loan.
    const first = firstLoanOn && firstLoanOn < approvedOn ? firstLoanOn : approvedOn;
    const inFirstYear = approvedOn < addMonths(first, FIRST_LOAN_YEAR.months);
    const area = inFirstYear ? Math.min(farmArea, Number(FIRST_LOAN_YEAR.maxHectares)) : farmArea;
    const eligibleCents = Math.floor(area * Number(LOAN_POLICY.maxLoanPerHectare)) * 100;
    const amountCents = Math.min(eligibleCents, Math.max(500000, Math.floor((eligibleCents * plan.share) / 500000) * 500000));
    if (amountCents < 100000) { ctx.skipped(`${which}: the farm area allows less than PHP 1,000`); continue; }

    // The application, checked and recorded by the Loans page's own code.
    const application = await prepareApplication(client, {
      loanType: 'agricultural', loanMode: 'cash', amount: centsToString(amountCents), purpose: plan.purpose(member.crop.toLowerCase()),
      farmArea: String(borrower.farm_area_ha), cropsPlanted: member.crop, cropSeason: `Dry season ${submittedOn.slice(0, 4)}`, irrigationType: 'irrigated',
      collateralType: 'Harvest', collateralDetails: `Next ${member.crop.toLowerCase()} harvest`,
    }, borrower);
    // The most the member could borrow then (the application works it out as of today).
    application.financials = { ...application.financials, maximum_eligible_amount: centsToString(eligibleCents) };
    const request = await insertLoanRequest(client, req, { member: borrower, application, income, submittedBy: 'office' });
    await dateNewRows(ctx, submittedOn, '09:30');

    // Approved as the review approves it, on approvedOn.
    const { financials } = application;
    const loanId = (await client.query(
      `INSERT INTO loans (loan_number, loan_request_id, member_id, member_number, member_name, loan_type, amount, balance, interest_rate, term,
         date_approved, due_date, next_payment_date, monthly_payment, farm_area, maximum_eligible_amount, purpose, loan_mode,
         calculated_interest, total_repayment, in_kind_items, collateral_type, collateral_details, created_at, updated_at)
       VALUES ('L-TMP-' || left(md5(random()::text), 20), $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9,
         $10::date, $10::date + make_interval(months => $9::int), $10::date + make_interval(months => $9::int), $11::numeric, $12::numeric, $13::numeric, $14, 'cash',
         $15::numeric, $7::numeric, '[]'::jsonb, $16, $17, ${stampSql('$10', '15:00')}, ${stampSql('$10', '15:00')})
       RETURNING id`,
      [request.id, borrower.id, borrower.member_number, borrower.full_name, application.loanType, application.requestedAmount, financials.total_repayment,
        LOAN_POLICY.interestRate, application.term, approvedOn, financials.monthly_payment, application.farmArea, financials.maximum_eligible_amount,
        application.purpose, financials.calculated_interest, application.collateralType, application.collateralDetails]
    )).rows[0].id;
    await client.query(`UPDATE loans SET loan_number = 'L-' || TO_CHAR(date_approved, 'YYYY') || '-' || LPAD(id::text, 3, '0') WHERE id = $1`, [loanId]);
    await createInstallments(client, loanId);
    await recomputeLoanState(client, loanId);
    await client.query(`UPDATE loan_requests SET status = 'approved', reviewed_at = ${stampSql('$2', '15:00')}, reviewed_by = $3 WHERE id = $1`, [request.id, approvedOn, admin.id]);
    const release = approvedOn >= DEDUCTIONS_FROM ? await recordLoanDeductions(client, req, loanId) : null;
    await createAuditLog({
      client, user: req.user, action: 'LOAN_APPROVED', module: 'Loans', entityType: 'loan_request', entityId: String(request.id),
      description: `Loan request approved for ${borrower.full_name}`, oldValues: { status: 'pending' },
      newValues: { status: 'approved', loan_id: loanId, review_notes: '', amount: application.requestedAmount, capital_change: capitalChange(-amountCents), ...(release ? { deductions: deductionValues(release) } : {}) },
      userAgent: MEMBER_SEEDER_AGENT,
    });
    await notifyMember(client, borrower.id, {
      type: 'loan_approved', title: 'Loan application approved', severity: 'success', link: '/loan-status', entityType: 'loan_request', entityId: request.id,
      message: `Your agricultural loan application for ${pesos(amountCents)} was approved.${release ? ` ${deductionsText(release)}` : ''}`, dedupeKey: `loan-request-${request.id}-approved`,
    });
    await dateNewRows(ctx, approvedOn, '15:00');
    ctx.count('loans');

    // Repaid in one payment of the whole amount: two days before the due date,
    // or twelve days after it with the late penalty past the grace period.
    if (plan.paying) {
      const due = (await client.query(`SELECT MAX(due_date) AS due FROM loan_installments WHERE loan_id = $1 AND superseded_by IS NULL`, [loanId])).rows[0].due;
      let paidOn = officeDayOnOrBefore(addDays(due, plan.paying === 'late' ? 12 : -2));
      if (paidOn < approvedOn) paidOn = approvedOn;
      if (paidOn <= today) {
        const state = await recomputeLoanState(client, loanId);
        const penalty = await penaltyDue(client, loanId, paidOn);
        await insertLoanPayment(client, req, { loanId, amountCents: toCents(state.balance) + penalty.cents, paymentDate: paidOn });
        await dateNewRows(ctx, paidOn, '10:30');
        ctx.count('loan payments');
      }
    }
    firstLoanOn = first;
    taken.push([submittedOn, until]);
  }
}

// ---------------------------------------------------------------- attendance and dues

async function seedAttendance(ctx, hasDues) {
  const { client, member, admin } = ctx;
  const activities = (await client.query(
    `SELECT a.id, a.title, a.category, a.activity_date::text AS day, a.start_time::text AS start, a.end_time::text AS end,
            ${hasDues ? 'a.dues_charged_at IS NOT NULL' : 'FALSE'} AS charged
     FROM activities a
     WHERE a.attendance_finalized_at IS NOT NULL AND a.status = 'completed' AND a.activity_date BETWEEN $2::date AND $3::date
       AND NOT EXISTS (SELECT 1 FROM activity_attendance r WHERE r.activity_id = a.id AND r.member_id = $1)
     ORDER BY a.activity_date, a.id`,
    [member.id, later(member.membership_date, ctx.start), ctx.today]
  )).rows;
  if (!activities.length) {
    ctx.skipped('attendance: no finalized activity since the member joined without a record for them');
    return [];
  }
  const marks = activities.map((activity, n) => {
    const mark = MARKS[n % MARKS.length];
    return {
      activity, mark, remarks: mark === 'excused' ? EXCUSES[n % EXCUSES.length] : '',
      checkIn: mark === 'present' ? minutesAfter(activity.start, -10 + (n % 8)) : mark === 'late' ? minutesAfter(activity.start, 35) : null,
    };
  });
  await client.query(
    `INSERT INTO activity_attendance (activity_id, member_id, attendance_status, check_in_time, remarks, source, recorded_by, updated_by, created_at, updated_at)
     SELECT r.activity_id, $1, r.mark, r.check_in, r.remarks, 'office', $2, $2, (r.day + r.start) AT TIME ZONE '${TIME_ZONE}', (r.day + r.start) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($3::int[], $4::text[], $5::time[], $6::text[], $7::date[], $8::time[]) AS r(activity_id, mark, check_in, remarks, day, start)`,
    [member.id, admin.id, marks.map((m) => m.activity.id), marks.map((m) => m.mark), marks.map((m) => m.checkIn), marks.map((m) => m.remarks),
      marks.map((m) => m.activity.day), marks.map((m) => m.activity.start)]
  );
  ctx.count('attendance records', marks.length);
  return marks;
}

// The meetings' dues, as finalizing their attendance charges them (share capital
// and savings; the fine only for an absence without a valid reason), and their
// payment at the office a few days later, as the Dues page records it.
async function seedDues(ctx, marks) {
  const { client, member, admin, today } = ctx;
  const meetings = marks.filter((m) => m.activity.category === 'meeting' && m.activity.charged);
  if (!meetings.length) return;
  const kindsOf = (mark) => (mark === 'absent' ? ['share_capital', 'savings', 'absence_fine'] : ['share_capital', 'savings']);
  const rows = meetings.flatMap(({ activity, mark }) => kindsOf(mark).map((kind) => ({ activity, kind, cents: DUES[kind].cents })));
  const dueIds = (await client.query(
    `INSERT INTO member_dues (member_id, kind, amount, due_date, activity_id, description, created_by, created_at, updated_at)
     SELECT $1, r.kind, r.amount, r.day, r.activity_id, r.description, $2, (r.day + r.at) AT TIME ZONE '${TIME_ZONE}', (r.day + r.at) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($3::text[], $4::numeric[], $5::date[], $6::int[], $7::text[], $8::time[]) WITH ORDINALITY AS r(kind, amount, day, activity_id, description, at, ord)
     ORDER BY r.ord RETURNING id`,
    [member.id, admin.id, rows.map((r) => r.kind), rows.map((r) => centsToString(r.cents)), rows.map((r) => r.activity.day), rows.map((r) => r.activity.id),
      rows.map((r) => `${DUES[r.kind].label}: ${r.activity.title}`), rows.map((r) => r.activity.end)]
  )).rows.map((row) => row.id);
  rows.forEach((row, index) => { row.id = dueIds[index]; });
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
     SELECT u.id, 'dues_charged', LEFT(r.title, 200), r.message, 'info', '/member/dues', 'activity', r.activity_id::text, 'dues-meeting-' || r.activity_id || '-charged-' || u.id,
            (r.day + r.at) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($2::int[], $3::text[], $4::text[], $5::date[], $6::time[]) AS r(activity_id, title, message, day, at)
     JOIN users u ON u.member_id = $1 AND u.account_status = 'ACTIVE'
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [member.id, meetings.map((m) => m.activity.id), meetings.map((m) => `Meeting dues: ${m.activity.title}`),
      meetings.map((m) => meetingDuesMessage(m.activity.title, m.activity.day, rows.filter((r) => r.activity === m.activity).map((r) => ({ kind: r.kind, cents: r.cents })))),
      meetings.map((m) => m.activity.day), meetings.map((m) => m.activity.end)]
  );
  ctx.count('dues', rows.length);

  // Paid together, three to seven days after the meeting (on an office day, never after today).
  const latest = officeDayOnOrBefore(today);
  const payments = meetings.map(({ activity }, n) => {
    const dues = rows.filter((r) => r.activity === activity);
    let day = officeDayOnOrBefore(addDays(activity.day, 3 + (n % 5)));
    if (day > latest) day = latest;
    if (day < activity.day) day = activity.day;
    const sum = (kind) => dues.filter((due) => due.kind === kind).reduce((total, due) => total + due.cents, 0);
    return { day, dues, totalCents: dues.reduce((total, due) => total + due.cents, 0), shareCents: sum('share_capital'), savingsCents: sum('savings') };
  });
  const shareTotal = payments.reduce((total, p) => total + p.shareCents, 0);
  const room = await shareCapitalRoomCents(client, member.id);
  if (shareTotal > room) throw new Error(`The member's share capital is at the 10% limit: the share capital of their meeting dues (${pesos(shareTotal)}) does not fit (${pesos(room)} left).`);

  const note = (p) => `Meeting dues: Dues paid at the office (${p.dues.length} ${p.dues.length === 1 ? 'due' : 'dues'}).`;
  const shareIds = (await client.query(
    `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, notes, recorded_by, created_at, updated_at)
     SELECT $1, r.amount, r.day, $2, r.notes, $3, ${stampSql('r.day', '11:00')}, ${stampSql('r.day', '11:00')}
     FROM unnest($4::numeric[], $5::date[], $6::text[]) WITH ORDINALITY AS r(amount, day, notes, ord) ORDER BY r.ord RETURNING id`,
    [member.id, DUES_PAYMENT_METHOD, admin.id, payments.map((p) => centsToString(p.shareCents)), payments.map((p) => p.day), payments.map(note)]
  )).rows.map((row) => row.id);
  const savingsIds = (await client.query(
    `INSERT INTO savings_transactions (member_id, transaction_type, amount, transaction_date, payment_method, notes, recorded_by, created_at)
     SELECT $1, 'deposit', r.amount, r.day, $2, r.notes, $3, ${stampSql('r.day', '11:00')}
     FROM unnest($4::numeric[], $5::date[], $6::text[]) WITH ORDINALITY AS r(amount, day, notes, ord) ORDER BY r.ord RETURNING id`,
    [member.id, DUES_PAYMENT_METHOD, admin.id, payments.map((p) => centsToString(p.savingsCents)), payments.map((p) => p.day), payments.map(note)]
  )).rows.map((row) => row.id);
  const paymentIds = (await client.query(
    `INSERT INTO member_dues_payments (member_id, amount, payment_date, payment_method, notes, share_contribution_id, savings_transaction_id, recorded_by, created_at)
     SELECT $1, r.amount, r.day, $2, '', r.share_id, r.savings_id, $3, ${stampSql('r.day', '11:00')}
     FROM unnest($4::numeric[], $5::date[], $6::int[], $7::int[]) WITH ORDINALITY AS r(amount, day, share_id, savings_id, ord) ORDER BY r.ord RETURNING id`,
    [member.id, DUES_PAYMENT_METHOD, admin.id, payments.map((p) => centsToString(p.totalCents)), payments.map((p) => p.day), shareIds, savingsIds]
  )).rows.map((row) => row.id);
  const links = payments.flatMap((p, i) => p.dues.map((due) => [due.id, paymentIds[i]]));
  await client.query(`UPDATE member_dues d SET payment_id = r.payment_id FROM unnest($1::int[], $2::int[]) AS r(id, payment_id) WHERE d.id = r.id`,
    [links.map(([dueId]) => dueId), links.map(([, paymentId]) => paymentId)]);
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, new_values, user_agent, created_at)
     SELECT $1, $2, $3, 'DUES_PAYMENT_RECORDED', 'Dues', 'member_dues_payment', r.id::text,
            'Recorded a dues payment of ' || r.pesos || ' for member ' || $5 || ' (' || r.count || CASE WHEN r.count = 1 THEN ' due)' ELSE ' dues)' END,
            jsonb_build_object('member_id', $6::int, 'amount', r.amount, 'capital_change', '+' || r.amount, 'payment_date', r.day, 'payment_method', $7::text), $4, ${stampSql('r.day', '11:00')}
     FROM unnest($8::int[], $9::numeric[], $10::text[], $11::date[], $12::int[]) AS r(id, amount, pesos, day, count)`,
    [admin.id, admin.username, admin.role, MEMBER_SEEDER_AGENT, member.member_number, member.id, DUES_PAYMENT_METHOD, paymentIds,
      payments.map((p) => centsToString(p.totalCents)), payments.map((p) => pesos(p.totalCents)), payments.map((p) => p.day), payments.map((p) => p.dues.length)]
  );
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
     SELECT u.id, 'dues_paid', 'Dues payment recorded', r.message, 'success', '/member/dues', 'member_dues_payment', r.id::text, 'dues-payment-' || r.id, ${stampSql('r.day', '11:00')}
     FROM unnest($2::int[], $3::text[], $4::date[]) AS r(id, message, day)
     JOIN users u ON u.member_id = $1 AND u.account_status = 'ACTIVE'
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [member.id, paymentIds, payments.map((p) => `A payment of ${pesos(p.totalCents)} for ${p.dues.length} ${p.dues.length === 1 ? 'due' : 'dues'} was recorded.`), payments.map((p) => p.day)]
  );
  ctx.count('dues payments', payments.length);
}

// ---------------------------------------------------------------- share capital and savings

// Running totals for the audit entries: what the member had before and after
// each new entry (their records already there, and the new ones before it, by
// date). `existing` and `entries` are { day, delta } with delta in signed cents.
function withTotals(existing, entries) {
  const all = [...existing.map((row) => ({ ...row, existing: true })), ...entries];
  all.sort((a, b) => a.day.localeCompare(b.day) || (a.existing === b.existing ? 0 : a.existing ? -1 : 1));
  let total = 0;
  for (const row of all) {
    row.before = total;
    total += row.delta;
    row.after = total;
  }
}

async function seedShareCapital(ctx) {
  const { client, member, admin, today } = ctx;
  let room = await shareCapitalRoomCents(client, member.id);
  const entries = [];
  for (const [monthsAgo, amount] of CONTRIBUTIONS) {
    const day = officeDayOnOrBefore(dayOfMonth(addMonths(today, -monthsAgo), 14));
    const cents = toCents(amount);
    if (day <= member.membership_date || day < ctx.start || day > today) continue;
    if (cents > room) {
      ctx.skipped(`share capital of ${pesos(cents)} on ${day}: over the 10% share capital limit`);
      continue;
    }
    room -= cents;
    entries.push({ day, cents, delta: cents });
  }
  if (!entries.length) return;
  const existing = (await client.query('SELECT contribution_date::text AS day, amount FROM share_contributions WHERE member_id = $1', [member.id])).rows;
  withTotals(existing.map((row) => ({ day: row.day, delta: toCents(row.amount) })), entries);
  const ids = (await client.query(
    `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, notes, recorded_by, created_at, updated_at)
     SELECT $1, r.amount, r.day, 'Cash', 'Additional share capital', $2, ${stampSql('r.day', '10:00')}, ${stampSql('r.day', '10:00')}
     FROM unnest($3::numeric[], $4::date[]) WITH ORDINALITY AS r(amount, day, ord) ORDER BY r.ord RETURNING id`,
    [member.id, admin.id, entries.map((e) => centsToString(e.cents)), entries.map((e) => e.day)]
  )).rows.map((row) => row.id);
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, old_values, new_values, user_agent, created_at)
     SELECT $1, $2, $3, 'SHARE_CONTRIBUTION_CREATED', 'Shares', 'share_contribution', r.id::text, 'Recorded share contribution for member ' || $5,
            jsonb_build_object('total', r.before),
            jsonb_build_object('member_id', $6::int, 'amount', r.amount, 'capital_change', '+' || r.amount, 'total', r.after, 'contribution_date', r.day, 'payment_method', 'Cash'),
            $4, ${stampSql('r.day', '10:00')}
     FROM unnest($7::int[], $8::numeric[], $9::numeric[], $10::numeric[], $11::date[]) AS r(id, amount, before, after, day)`,
    [admin.id, admin.username, admin.role, MEMBER_SEEDER_AGENT, member.member_number, member.id, ids, entries.map((e) => centsToString(e.cents)),
      entries.map((e) => centsToString(e.before)), entries.map((e) => centsToString(e.after)), entries.map((e) => e.day)]
  );
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
     SELECT u.id, 'savings_recorded', 'Share contribution recorded', r.message, 'success', '/member-profile', 'share_contribution', r.id::text, 'share-contribution-' || r.id,
            ${stampSql('r.day', '10:00')}
     FROM unnest($2::int[], $3::text[], $4::date[]) AS r(id, message, day)
     JOIN users u ON u.member_id = $1 AND u.account_status = 'ACTIVE'
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [member.id, ids, entries.map((e) => `A contribution of ${pesos(e.cents)} was recorded. Your total share capital is ${pesos(e.after)}.`), entries.map((e) => e.day)]
  );
  ctx.count('share capital contributions', entries.length);
}

async function seedSavings(ctx) {
  const { client, member, admin, today } = ctx;
  const entries = [];
  for (let monthsAgo = HISTORY_MONTHS - 1; monthsAgo >= 0; monthsAgo -= 1) {
    if (monthsAgo % 7 === 5) continue; // a month skipped now and then
    const day = officeDayOnOrBefore(dayOfMonth(addMonths(today, -monthsAgo), 6 + (monthsAgo % 4)));
    if (day <= member.membership_date || day < ctx.start || day > today) continue;
    const harvest = HARVEST_MONTHS.has(Number(day.slice(5, 7)));
    const cents = harvest ? 150000 : 50000;
    entries.push({ day, kind: 'deposit', cents, delta: cents, method: monthsAgo % 4 === 1 ? 'GCash' : 'Cash', notes: harvest ? 'Savings from the harvest' : 'Monthly savings', time: '10:00' });
  }
  // What the member has saved already (with the savings parts of their loans and dues added above).
  const existing = (await client.query(
    `SELECT transaction_date::text AS day, CASE WHEN transaction_type = 'withdrawal' THEN -amount ELSE amount END AS amount FROM savings_transactions WHERE member_id = $1`, [member.id]
  )).rows.map((row) => ({ day: row.day, delta: toCents(row.amount) }));
  // Withdrawals that leave more than the maintaining balance on the day.
  for (const [monthsAgo, amount] of WITHDRAWALS) {
    const day = officeDayOnOrBefore(dayOfMonth(addMonths(today, -monthsAgo), 20));
    if (day <= member.membership_date || day < ctx.start || day > today) continue;
    const balance = [...existing, ...entries].filter((row) => row.day <= day).reduce((sum, row) => sum + row.delta, 0);
    if (balance - toCents(amount) < MAINTAINING_CENTS) continue;
    entries.push({ day, kind: 'withdrawal', cents: toCents(amount), delta: -toCents(amount), method: 'Cash', notes: 'Withdrawn at the office', time: '14:00' });
  }
  if (!entries.length) return;
  withTotals(existing, entries);
  const ids = (await client.query(
    `INSERT INTO savings_transactions (member_id, transaction_type, amount, transaction_date, payment_method, notes, recorded_by, created_at)
     SELECT $1, r.kind, r.amount, r.day, r.method, r.notes, $2, (r.day + r.at) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($3::text[], $4::numeric[], $5::date[], $6::text[], $7::text[], $8::time[]) WITH ORDINALITY AS r(kind, amount, day, method, notes, at, ord)
     ORDER BY r.ord RETURNING id`,
    [member.id, admin.id, entries.map((e) => e.kind), entries.map((e) => centsToString(e.cents)), entries.map((e) => e.day), entries.map((e) => e.method),
      entries.map((e) => e.notes), entries.map((e) => e.time)]
  )).rows.map((row) => row.id);
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, old_values, new_values, user_agent, created_at)
     SELECT $1, $2, $3, CASE WHEN r.kind = 'withdrawal' THEN 'SAVINGS_WITHDRAWAL_CREATED' ELSE 'SAVINGS_DEPOSIT_CREATED' END, 'Savings', 'savings_transaction', r.id::text,
            'Recorded savings ' || r.kind || ' for member ' || $5, jsonb_build_object('total_savings', r.before),
            jsonb_build_object('member_id', $6::int, 'amount', r.amount, 'capital_change', CASE WHEN r.kind = 'withdrawal' THEN '-' ELSE '+' END || r.amount,
                               'total_savings', r.after, 'date', r.day, 'payment_method', r.method),
            $4, (r.day + r.at) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($7::int[], $8::text[], $9::numeric[], $10::numeric[], $11::numeric[], $12::date[], $13::text[], $14::time[]) AS r(id, kind, amount, before, after, day, method, at)`,
    [admin.id, admin.username, admin.role, MEMBER_SEEDER_AGENT, member.member_number, member.id, ids, entries.map((e) => e.kind), entries.map((e) => centsToString(e.cents)),
      entries.map((e) => centsToString(e.before)), entries.map((e) => centsToString(e.after)), entries.map((e) => e.day), entries.map((e) => e.method), entries.map((e) => e.time)]
  );
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
     SELECT u.id, CASE WHEN r.kind = 'withdrawal' THEN 'savings_withdrawn' ELSE 'savings_recorded' END,
            CASE WHEN r.kind = 'withdrawal' THEN 'Savings withdrawal recorded' ELSE 'Savings deposit recorded' END, r.message, 'success', '/member/savings',
            'savings_transaction', r.id::text, 'savings-' || r.id, (r.day + r.at) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($2::int[], $3::text[], $4::text[], $5::date[], $6::time[]) AS r(id, kind, message, day, at)
     JOIN users u ON u.member_id = $1 AND u.account_status = 'ACTIVE'
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [member.id, ids, entries.map((e) => e.kind), entries.map((e) => `A savings ${e.kind} of ${pesos(e.cents)} was recorded. Your total savings are ${pesos(e.after)}.`),
      entries.map((e) => e.day), entries.map((e) => e.time)]
  );
  const deposits = entries.filter((e) => e.kind === 'deposit').length;
  if (deposits) ctx.count('savings deposits', deposits);
  if (entries.length > deposits) ctx.count('savings withdrawals', entries.length - deposits);
}

// ---------------------------------------------------------------- machinery

async function seedMachinery(ctx) {
  const { client, member, admin, today } = ctx;
  const hasSeason = (await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machinery_service_rates' AND column_name = 'season'`
  )).rows.length > 0;
  const rates = (await client.query(
    `SELECT r.id, r.machinery_id AS "machineryId", r.service_type AS "serviceType", r.unit, ${hasSeason ? 'r.season' : 'NULL::text AS season'}, r.member_rate AS "memberRate",
            r.non_member_rate AS "nonMemberRate", r.effective_from::text AS "effectiveFrom", r.effective_to::text AS "effectiveTo"
     FROM machinery_service_rates r JOIN machinery m ON m.id = r.machinery_id ORDER BY r.machinery_id, r.effective_from`
  )).rows;
  const area = Number(member.farm_area_ha) > 0 ? String(Number(member.farm_area_ha)) : '1';
  // Land preparation before the plantings (June, December), the harvester at the harvests (April, October).
  const plan = [];
  for (let monthsAgo = HISTORY_MONTHS - 1; monthsAgo >= 0; monthsAgo -= 1) {
    const month = Number(addMonths(today, -monthsAgo).slice(5, 7));
    const serviceType = month === 6 || month === 12 ? 'Rotavator' : month === 4 || month === 10 ? 'Harvesting' : null;
    if (!serviceType) continue;
    const day = dayOfMonth(addMonths(today, -monthsAgo), serviceType === 'Rotavator' ? 12 : 18);
    if (day <= member.membership_date || day < ctx.start || day >= today) continue;
    plan.push({ serviceType, day });
  }
  const rows = [];
  let noRate = 0;
  for (const [n, { serviceType, day }] of plan.entries()) {
    const choices = [...new Set(rates.map((rate) => rate.machineryId))]
      .map((machineryId) => findRateForDate(rates.filter((rate) => rate.machineryId === machineryId), serviceType, day))
      .filter(Boolean);
    if (!choices.length) { noRate += 1; continue; }
    const rate = choices[n % choices.length];
    const bags = rate.unit === 'per_100_bags' || rate.unit === 'bags_per_ha';
    // Bags of palay harvested: 88 to 100 a hectare.
    const totalBags = bags || serviceType === 'Harvesting' ? String(Math.round(Number(area) * (88 + (n % 3) * 6))) : null;
    const fee = computeServiceFee({ unit: rate.unit, rate: rateForClient(rate, 'member'), areaHa: area, days: '1', totalBags, ...BAG });
    rows.push({ rate, day, bags, totalBags, fee });
  }
  if (noRate) ctx.skipped(`${noRate} machinery services: no machine had a rate for their date`);
  if (rows.length) {
    const ids = (await client.query(
      `INSERT INTO machinery_services (machinery_id, service_type, service_date, ${hasSeason ? 'season, ' : ''}cropping_period, year, client_category, member_id, client_name, client_address,
         unit, area_ha, total_bags, fee_bags, bag_value, kg_per_bag, price_per_kg, rate_id, rate_used, fee_amount, recorded_by, created_at, updated_at)
       SELECT r.machinery_id, r.service_type, r.day, ${hasSeason ? 'r.season, ' : ''}CASE WHEN EXTRACT(MONTH FROM r.day) <= 7 THEN '1st' ELSE '2nd' END, EXTRACT(YEAR FROM r.day)::int,
              'member', $1, $2, $3, r.unit, $4::numeric, r.total_bags, r.fee_bags, r.bag_value,
              CASE WHEN r.bags THEN $5::numeric END, CASE WHEN r.bags THEN $6::numeric END, r.rate_id, r.rate_used, r.fee, $7, ${stampSql('r.day', '16:00')}, ${stampSql('r.day', '16:00')}
       FROM unnest($8::text[], $9::text[], $10::date[], $11::text[], $12::text[], $13::numeric[], $14::numeric[], $15::numeric[], $16::int[], $17::numeric[], $18::numeric[], $19::boolean[])
            WITH ORDINALITY AS r(machinery_id, service_type, day, season, unit, total_bags, fee_bags, bag_value, rate_id, rate_used, fee, bags, ord)
       ORDER BY r.ord RETURNING id`,
      [member.id, member.full_name, member.address, area, BAG.kgPerBag, BAG.pricePerKg, admin.id,
        rows.map((r) => r.rate.machineryId), rows.map((r) => r.rate.serviceType), rows.map((r) => r.day), rows.map((r) => r.rate.season ?? null), rows.map((r) => r.rate.unit),
        rows.map((r) => r.totalBags), rows.map((r) => r.fee.feeBags), rows.map((r) => r.fee.bagValue), rows.map((r) => r.rate.id), rows.map((r) => r.fee.rateUsed),
        rows.map((r) => r.fee.feeAmount), rows.map((r) => r.bags)]
    )).rows.map((row) => row.id);
    // Paid at the office on the day (a trigger keeps machinery_services.amount_paid).
    await client.query(
      `INSERT INTO machinery_service_payments (service_id, amount, payment_date, notes, recorded_by, created_at)
       SELECT r.id, r.amount, r.day, 'Paid when the service was recorded', $1, ${stampSql('r.day', '16:00')}
       FROM unnest($2::int[], $3::numeric[], $4::date[]) AS r(id, amount, day) WHERE r.amount > 0`,
      [admin.id, ids, rows.map((r) => r.fee.feeAmount), rows.map((r) => r.day)]
    );
    ctx.count('machinery services', rows.length);
  }

  // One day rental of a machine rented by the day, five months ago, on a day it was free.
  const machine = (await client.query(
    `SELECT id, name, type, daily_fee FROM machinery WHERE pricing_mode = 'per_day' AND daily_fee > 0 AND parent_machinery_id IS NULL ORDER BY id LIMIT 1`
  )).rows[0];
  if (!machine) return;
  // The bookings around then, to pick days the machine was free (as the booking form requires).
  const from = dayOfMonth(addMonths(today, -5), 3);
  const bookings = (await client.query(
    `SELECT start_date::text AS start_date, end_date::text AS end_date FROM machinery_operations WHERE machinery_id = $1 AND end_date >= $2::date AND start_date <= $3::date
     UNION ALL SELECT start_date::text, end_date::text FROM rental_requests WHERE machinery_id = $1 AND status IN ('pending', 'approved') AND end_date >= $2::date AND start_date <= $3::date`,
    [machine.id, from, addDays(from, 45)]
  )).rows;
  let start = null;
  for (let day = from; day < addDays(from, 44) && !start; day = addDays(day, 1)) {
    if (!bookings.some((booking) => booking.start_date <= addDays(day, 1) && booking.end_date >= day)) start = day;
  }
  const end = () => addDays(start, 1);
  if (!start || start <= member.membership_date || start < ctx.start || end() >= today) return;
  const purpose = /pump|irrigat/i.test(`${machine.name} ${machine.type}`) ? 'Irrigating the rice field' : /thresh/i.test(`${machine.name} ${machine.type}`) ? 'Threshing palay' : 'Land preparation';
  const submitted = addDays(start, -7);
  const requestId = (await client.query(
    `INSERT INTO rental_requests (machinery_id, client_category, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, notes,
       status, submitted_at, reviewed_at, reviewed_by)
     VALUES ($1, 'member', $2, $3, $4, $5::date, $6::date, 1, $7::numeric, '', 'approved', ${stampSql('$8')}, ${stampSql('$8', '15:00')}, $9)
     RETURNING id`,
    [machine.id, member.id, member.full_name, purpose, start, end(), machine.daily_fee, submitted, admin.id]
  )).rows[0].id;
  const operationId = (await client.query(
    `INSERT INTO machinery_operations (rental_request_id, machinery_id, machinery_name, client_category, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, status)
     VALUES ($1, $2, $3, 'member', $4, $5, $6, $7::date, $8::date, 1, $9::numeric, 'completed') RETURNING id`,
    [requestId, machine.id, machine.name, member.id, member.full_name, purpose, start, end(), machine.daily_fee]
  )).rows[0].id;
  await client.query(
    `INSERT INTO machinery_rental_payments (operation_id, amount, payment_date, notes, recorded_by, created_at)
     VALUES ($1, $2::numeric, $3::date, 'Paid at the office', $4, ${stampSql('$3', '15:30')})`,
    [operationId, machine.daily_fee, end(), admin.id]
  );
  ctx.count('machinery rentals');
}

// ---------------------------------------------------------------- Kadiwa

// Two purchases a month on the store's daily sales of the last year (patronage
// points), each within what the day's sales left after the other buyers on it.
async function seedKadiwa(ctx) {
  const { client, member, today } = ctx;
  const sales = (await client.query(
    `SELECT s.id, s.sale_date::text AS day, (s.groceries + s.vegetables + s.meat) AS gross,
            COALESCE((SELECT SUM(p.amount) FROM kadiwa_sale_members p WHERE p.sale_id = s.id), 0) AS taken,
            COALESCE((SELECT MAX(p.line_no) FROM kadiwa_sale_members p WHERE p.sale_id = s.id), 0) AS last_line
     FROM kadiwa_sales s
     WHERE s.status = 'completed' AND s.sale_date BETWEEN $2::date AND $3::date
       AND NOT EXISTS (SELECT 1 FROM kadiwa_sale_members p WHERE p.sale_id = s.id AND p.member_id = $1)
     ORDER BY s.sale_date, s.id`,
    [member.id, later(addDays(member.membership_date, 1), later(ctx.start, addMonths(today, -12))), addDays(today, -1)]
  )).rows;
  const purchases = [];
  const months = [...new Set(sales.map((sale) => sale.day.slice(0, 7)))];
  for (const month of months) {
    for (const target of [9, 23]) {
      const sale = sales.find((s) => s.day.slice(0, 7) === month && Number(s.day.slice(8, 10)) >= target && !purchases.some((p) => p.sale === s));
      if (!sale) continue;
      const cents = PURCHASE_CENTS[purchases.length % PURCHASE_CENTS.length];
      if (toCents(sale.gross) - toCents(sale.taken) < cents) continue;
      purchases.push({ sale, cents });
    }
  }
  if (!purchases.length) return;
  await client.query(
    `INSERT INTO kadiwa_sale_members (sale_id, line_no, member_id, member_number, member_name, amount, created_at)
     SELECT r.sale_id, r.line_no, $1, $2, $3, r.amount, ${stampSql('r.day', '17:30')}
     FROM unnest($4::text[], $5::int[], $6::numeric[], $7::date[]) AS r(sale_id, line_no, amount, day)`,
    [member.id, member.member_number, member.full_name, purchases.map((p) => p.sale.id), purchases.map((p) => Number(p.sale.last_line) + 1),
      purchases.map((p) => centsToString(p.cents)), purchases.map((p) => p.sale.day)]
  );
  ctx.count('Kadiwa purchases', purchases.length);
}

// ---------------------------------------------------------------- the run

/**
 * Adds the history to ctx.member inside ctx.client's transaction and records
 * what it wrote (one HISTORY_ACTION audit entry). ctx: { client, today, admin,
 * req, member, count(label, n), skipped(reason) }. Returns the ids written, by table.
 */
export async function seedMemberHistory(ctx) {
  const { client, member, today } = ctx;
  ctx.start = later(addDays(member.membership_date, 7), addMonths(today, -HISTORY_MONTHS));
  member.crop = Number(member.corn_area_ha) > 0 && !(Number(member.palay_area_ha) > 0) ? 'Corn' : 'Rice';
  const hasDues = await tableExists(client, 'member_dues');

  await seedLoans(ctx);
  const marks = await seedAttendance(ctx, hasDues);
  if (hasDues) await seedDues(ctx, marks);
  else ctx.skipped('dues: the database has no dues tables yet (migration 069)');
  await seedShareCapital(ctx);
  await seedSavings(ctx);
  await seedMachinery(ctx);
  await seedKadiwa(ctx);

  // members.share_capital is the sum of the contributions, as the Shares page keeps it.
  await client.query(`UPDATE members SET share_capital = (SELECT COALESCE(SUM(amount), 0) FROM share_contributions WHERE member_id = $1) WHERE id = $1`, [member.id]);
  // Notifications about past records are history, not news: already read, and not sent to a phone.
  const pushColumn = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'pushed_at'`)).rows.length;
  await client.query(`UPDATE notifications SET read_at = COALESCE(read_at, NOW())${pushColumn ? ', pushed_at = COALESCE(pushed_at, NOW())' : ''} WHERE ${THIS_TRANSACTION}`);

  // Every row written, by table, for removeMemberHistory.
  const ids = {};
  for (const table of MEMBER_TABLES) {
    if (!(await tableExists(client, table))) continue;
    ids[table] = (await client.query(`SELECT id FROM ${table} WHERE member_id = $1 AND ${THIS_TRANSACTION} ORDER BY id`, [member.id])).rows.map((row) => Number(row.id));
  }
  ids.notifications = (await client.query(`SELECT id FROM notifications WHERE ${THIS_TRANSACTION} ORDER BY id`)).rows.map((row) => Number(row.id));
  ids.audit_logs = (await client.query(`SELECT id FROM audit_logs WHERE ${THIS_TRANSACTION} ORDER BY id`)).rows.map((row) => Number(row.id));
  const counts = Object.fromEntries(ctx.counts);
  await createAuditLog({
    client, user: ctx.req.user, action: HISTORY_ACTION, module: 'System', entityType: 'member', entityId: String(member.id),
    description: `Added two years of sample records to member ${member.member_number} (npm run seed:member).`,
    newValues: { member_number: member.member_number, counts, ids }, userAgent: MEMBER_SEEDER_AGENT,
  });
  return ids;
}
