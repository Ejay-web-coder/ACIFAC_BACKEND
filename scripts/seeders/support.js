import { TIME_ZONE } from '../../src/config/env.js';
import { isPaymentDay } from '../../src/services/officeHours.js';

// Helpers shared by the seeders. Dates are YYYY-MM-DD strings counted from the
// day the seeder runs, so the sample data always looks current: loans fall due
// around today, the latest sales are this week's, and so on.

const toDate = (day) => new Date(`${day}T00:00:00Z`);
const toDay = (date) => date.toISOString().slice(0, 10);

export function addDays(day, days) {
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() + days);
  return toDay(date);
}

// Same day of the month, or the month's last day (Jan 31 + 1 month = Feb 28),
// as PostgreSQL's date + interval does.
export function addMonths(day, months) {
  const date = toDate(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toDay(target);
}

// The office receives loan payments on weekdays only: the nearest such day on or before `day`.
export function officeDayOnOrBefore(day) {
  let current = day;
  for (let step = 0; step < 7 && !isPaymentDay(current); step += 1) current = addDays(current, -1);
  return current;
}

// The cropping a date belongs to, as on the PhilMech report (January to July is the 1st).
export const croppingPeriodOf = (day) => (Number(day.slice(5, 7)) <= 7 ? '1st' : '2nd');

// A timestamp on `day` at `time` in the cooperative's time zone, for created_at
// columns, so records entered "back then" are not all stamped with today.
export const stampSql = (dayParam, time = '09:00') => `((${dayParam})::date + TIME '${time}') AT TIME ZONE '${TIME_ZONE}'`;

// What the app's own helpers read from a request: the administrator doing the
// work (for audit logs and recorded_by) and the client details.
export function actingRequest(admin) {
  return { user: { ...admin, user_id: admin.id }, headers: { 'user-agent': 'ACIFAC seeder (npm run seed)' }, ip: null };
}
