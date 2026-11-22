// Rules of the Membership Policy that decide who may join and come back (no
// database access, so they can be unit tested).
import { formatDateOnly, isValidDateOnly, todayDateOnly } from '../utils/dates.js';

// "Age limit 18-65 years old", on the membership date.
export const MEMBER_MIN_AGE = 18;
export const MEMBER_MAX_AGE = 65;

/** Full years from birthDate to onDate (both YYYY-MM-DD). */
export function ageOn(birthDate, onDate) {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** The age-limit problem with a birth date and membership date, or null. */
export function membershipAgeError(birthDate, membershipDate) {
  if (!isValidDateOnly(birthDate) || !isValidDateOnly(membershipDate)) return null;
  const age = ageOn(birthDate, membershipDate);
  if (age >= MEMBER_MIN_AGE && age <= MEMBER_MAX_AGE) return null;
  return `A member must be ${MEMBER_MIN_AGE} to ${MEMBER_MAX_AGE} years old on the membership date (Membership Policy). With this birthday the applicant was ${age} on ${formatDateOnly(membershipDate)}.`;
}

/**
 * Why a terminated membership cannot be restored, or null. "Ang member na
 * nagresign ay hindi pupwedeng bumalik bilang kasapi": a member who resigned
 * (voluntary termination) cannot come back. A resignation recorded by mistake
 * can be undone on the day it was recorded.
 */
export function restoreBlockedReason(termination, today = todayDateOnly()) {
  if (termination?.type !== 'voluntary') return null;
  if (termination.date && termination.date === today) return null;
  return 'This member resigned, and a member who resigned cannot come back as a member of the cooperative (Membership Policy). A resignation recorded by mistake can only be undone on the day it was recorded.';
}

// Loyalty awards go to members in good standing: in the 12 months up to the
// award date they attended at least this share of the activities they had to
// attend, and paid their loans on time.
export const LOYALTY_MIN_ATTENDANCE = 75;
// Members are told when they complete every 5 years of membership.
export const LOYALTY_MILESTONE_YEARS = 5;

/**
 * A member's standing for a loyalty award from their last 12 months:
 * { eligible, attended } activities, late loan payments and overdue loans.
 * A member with no activity to attend is not held back by attendance.
 */
export function loyaltyStanding({ eligible = 0, attended = 0, latePayments = 0, overdueLoans = 0 }, minAttendance = LOYALTY_MIN_ATTENDANCE) {
  const total = Number(eligible) || 0;
  const came = Number(attended) || 0;
  const rate = total > 0 ? Math.round((came / total) * 1000) / 10 : null;
  const late = Number(latePayments) || 0;
  const overdue = Number(overdueLoans) || 0;
  const reasons = [];
  if (rate !== null && rate < minAttendance) reasons.push(`Attended ${came} of ${total} activities (${rate}%, ${minAttendance}% needed)`);
  if (late > 0) reasons.push(`${late} late loan ${late === 1 ? 'payment' : 'payments'}`);
  if (overdue > 0) reasons.push(`${overdue === 1 ? 'A loan is' : `${overdue} loans are`} overdue`);
  return { goodStanding: reasons.length === 0, attendanceRate: rate, attended: came, eligible: total, latePayments: late, overdueLoans: overdue, reasons };
}

/** The award a milestone reaches, as the certificates name it (5, 10, 15 years; 15+ after). */
export function loyaltyAwardName(years) {
  if (years >= 15) return years === 15 ? '15-Year Loyalty Award' : 'loyalty award';
  if (years >= 10) return '10-Year Loyalty Award';
  return years >= 5 ? '5-Year Loyalty Award' : null;
}
