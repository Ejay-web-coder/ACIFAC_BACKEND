import { query } from '../config/db.js';
import { centsToString, toCents } from '../utils/money.js';
import { formatDateOnly } from '../utils/dates.js';

// The savings and share capital records are made by memberController, which
// imports loanController, which imports this module: it is loaded when first
// needed, so this module never takes part in that cycle.
const memberRecords = () => import('../controllers/memberController.js');

// The loan policy (Polisiya sa Pagpapautang, ALERT-ARBOs; sql/060), as the
// office reads it:
//   Rule 2   "Hanggang dalawang ektarya lamang ... sa unang taon ng operasyon
//            (dalawang cropping)": in a member's first year of loans, counted
//            from their first loan (12 months, two croppings), a loan covers at
//            most 2 hectares. A member's first loan is in that year too.
//   Rule 10  PHP 500 savings is taken from the proceeds of a loan of PHP 50,000
//            or less, PHP 1,000 from a larger one.
//   Rule 11  2% of the loan goes to Capital Build-Up (share capital; the part
//            over the member's 10% share capital limit goes to savings instead).
//   Rule 12  PHP 50 PCIC life insurance.
// The deductions come out of the cash part of the loan; what that cash cannot
// cover (an in-kind loan has none) the borrower pays at the office at release.
export const LOAN_DEDUCTIONS = Object.freeze({
  savingsUpToCents: 5000000,
  savingsSmallCents: 50000,
  savingsLargeCents: 100000,
  capitalBuildUpPercent: 2,
  pcicInsuranceCents: 5000,
});
export const FIRST_LOAN_YEAR = Object.freeze({ maxHectares: '2', months: 12 });

/** What the policy takes from a loan of `amountCents`, in cents. */
export function loanDeductions(amountCents) {
  const savingsCents = amountCents <= LOAN_DEDUCTIONS.savingsUpToCents ? LOAN_DEDUCTIONS.savingsSmallCents : LOAN_DEDUCTIONS.savingsLargeCents;
  const capitalBuildUpCents = Math.round((amountCents * LOAN_DEDUCTIONS.capitalBuildUpPercent) / 100);
  const pcicCents = LOAN_DEDUCTIONS.pcicInsuranceCents;
  return { savingsCents, capitalBuildUpCents, pcicCents, totalCents: savingsCents + capitalBuildUpCents + pcicCents };
}

/**
 * The release of a loan: its deductions, the cash the borrower receives (the
 * cash part, less what a restructured loan still owed and the deductions) and
 * what the cash cannot cover, paid at release. All in cents.
 */
export function loanRelease({ amountCents, inKindCents = 0, carriedCents = 0 }) {
  const deductions = loanDeductions(amountCents);
  const cashPartCents = Math.max(0, amountCents - inKindCents);
  const availableCents = Math.max(0, cashPartCents - carriedCents);
  const fromProceedsCents = Math.min(deductions.totalCents, availableCents);
  return {
    ...deductions,
    cashPartCents,
    cashReleasedCents: availableCents - fromProceedsCents,
    paidAtReleaseCents: deductions.totalCents - fromProceedsCents,
  };
}

/** The farm inputs of a loan, in cents (none for a cash loan; an in-kind loan is all inputs). */
export function inKindCentsOf({ loanMode, amountCents, inKindItems }) {
  if (!loanMode || loanMode === 'cash') return 0;
  if (loanMode === 'in-kind') return amountCents;
  const items = Array.isArray(inKindItems) ? inKindItems : [];
  const total = items.reduce((sum, item) => sum + Math.round(Number(item.quantity) * toCents(item.unitPrice)), 0);
  return Math.min(amountCents, Number.isFinite(total) ? total : 0);
}

const run = (db) => (db && typeof db.query === 'function' ? db.query.bind(db) : query);

/**
 * The member's first year of loans on `today` (YYYY-MM-DD): firstLoanOn, the
 * day it ends (endsOn, null before the first loan) and whether `today` is in it.
 */
export async function firstLoanYear(db, memberId, today) {
  const row = (await run(db)(
    `SELECT TO_CHAR(MIN(date_approved), 'YYYY-MM-DD') AS first_loan_on,
            TO_CHAR((MIN(date_approved) + make_interval(months => $2))::date, 'YYYY-MM-DD') AS ends_on
     FROM loans WHERE member_id = $1`,
    [memberId, FIRST_LOAN_YEAR.months]
  )).rows[0];
  const firstLoanOn = row?.first_loan_on ?? null;
  const endsOn = row?.ends_on ?? null;
  return { firstLoanOn, endsOn, inFirstYear: !endsOn || today < endsOn };
}

/** The farm area a loan may be for: at most 2 hectares in the member's first year of loans. */
export function eligibleFarmArea(farmArea, firstYear) {
  return firstYear?.inFirstYear && Number(farmArea) > Number(FIRST_LOAN_YEAR.maxHectares) ? FIRST_LOAN_YEAR.maxHectares : String(farmArea);
}

/** "In a member's first year of loans (until May 24, 2027), a loan may cover at most 2 hectares" */
export function firstYearLimitText(firstYear) {
  const until = firstYear?.endsOn ? `until ${formatDateOnly(firstYear.endsOn)}` : 'counted from their first loan';
  return `In a member's first year of loans (${until}), a loan may cover at most ${FIRST_LOAN_YEAR.maxHectares} hectares`;
}

const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

/**
 * Takes the deductions from a loan just released, in the caller's transaction
 * (after a restructuring has paid off the old loan; carriedCents is what it
 * still owed): the savings deposit, the Capital Build-Up as share capital up to
 * the 10% limit and the rest as savings, and the figures kept on the loan.
 * Returns the release (cents), with shareCents and overLimitCents of the CBU.
 */
export async function recordLoanDeductions(client, req, loanId, { carriedCents = 0 } = {}) {
  const loan = (await client.query(
    `SELECT id, loan_number, member_id, amount, loan_mode, in_kind_items, TO_CHAR(date_approved, 'YYYY-MM-DD') AS date_approved FROM loans WHERE id = $1`,
    [loanId]
  )).rows[0];
  const amountCents = toCents(loan.amount);
  const release = loanRelease({ amountCents, inKindCents: inKindCentsOf({ loanMode: loan.loan_mode, amountCents, inKindItems: loan.in_kind_items }), carriedCents });
  const common = { memberId: loan.member_id, date: loan.date_approved, paymentMethod: 'Loan deduction' };
  const { insertSavingsDeposit, insertShareContribution, shareCapitalRoomCents } = await memberRecords();

  const savings = await insertSavingsDeposit(client, req, {
    ...common, amountCents: release.savingsCents, reference: `${loan.loan_number}-SAV`, notes: `Savings taken from the proceeds of loan ${loan.loan_number} (loan policy).`,
  });
  const shareCents = Math.min(release.capitalBuildUpCents, await shareCapitalRoomCents(client, loan.member_id));
  const overLimitCents = release.capitalBuildUpCents - shareCents;
  const share = shareCents > 0
    ? await insertShareContribution(client, req, loan.member_id, {
      amountCents: shareCents, contributionDate: loan.date_approved, paymentMethod: 'Loan deduction', referenceNumber: `${loan.loan_number}-CBU`,
      notes: `Capital Build-Up (2%) taken from the proceeds of loan ${loan.loan_number}.`,
    })
    : null;
  const overLimit = overLimitCents > 0
    ? await insertSavingsDeposit(client, req, {
      ...common, amountCents: overLimitCents, reference: `${loan.loan_number}-CBU`,
      notes: `Capital Build-Up (2%) of loan ${loan.loan_number} over the 10% share capital limit (${pesos(overLimitCents)} of ${pesos(release.capitalBuildUpCents)}), kept as savings.`,
    })
    : null;

  await client.query(
    `UPDATE loans SET savings_deducted = $2::numeric, capital_build_up = $3::numeric, capital_build_up_to_savings = $4::numeric, pcic_insurance = $5::numeric,
                      cash_released = $6::numeric, paid_at_release = $7::numeric,
                      savings_deduction_id = $8, capital_build_up_contribution_id = $9, capital_build_up_savings_id = $10
     WHERE id = $1`,
    [loanId, centsToString(release.savingsCents), centsToString(release.capitalBuildUpCents), centsToString(overLimitCents), centsToString(release.pcicCents),
      centsToString(release.cashReleasedCents), centsToString(release.paidAtReleaseCents), savings.record.id, share?.contribution.id ?? null, overLimit?.record.id ?? null]
  );
  return { ...release, shareCents, overLimitCents };
}

/** The deductions in an audit log entry (pesos as text). */
export const deductionValues = (release) => ({
  savings: centsToString(release.savingsCents),
  capital_build_up: centsToString(release.capitalBuildUpCents),
  ...(release.overLimitCents > 0 ? { capital_build_up_to_savings: centsToString(release.overLimitCents) } : {}),
  pcic_insurance: centsToString(release.pcicCents),
  cash_released: centsToString(release.cashReleasedCents),
  ...(release.paidAtReleaseCents > 0 ? { paid_at_release: centsToString(release.paidAtReleaseCents) } : {}),
});

/**
 * What the member is told about the deductions: "The loan policy deducts PHP
 * 500.00 savings, PHP 1,000.00 Capital Build-Up (2%) and PHP 50.00 PCIC
 * insurance from the proceeds; you receive PHP 48,450.00 in cash."
 */
export function deductionsText(release) {
  const deducts = `The loan policy deducts ${pesos(release.savingsCents)} savings, ${pesos(release.capitalBuildUpCents)} Capital Build-Up (2%) and ${pesos(release.pcicCents)} PCIC insurance from the proceeds`;
  const cash = release.cashReleasedCents > 0 ? `; you receive ${pesos(release.cashReleasedCents)} in cash` : '';
  const atRelease = release.paidAtReleaseCents > 0 ? ` The cash part of the loan does not cover ${pesos(release.paidAtReleaseCents)} of it: please pay that at the office when the loan is released.` : '';
  return `${deducts}${cash}.${atRelease}`;
}
