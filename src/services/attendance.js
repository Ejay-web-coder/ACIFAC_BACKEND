// Rules of member attendance monitoring (no database access, so they can be
// unit tested). The attendance rate of a member is
//   activities attended (present or late) ÷ eligible completed activities × 100
// where an eligible completed activity is a completed activity with final
// attendance at which the member has a record. Finalizing records every active
// member who was not marked as absent, so a member has a record at every
// final activity they were eligible for, and none at the others. Cancelled
// activities and activities whose attendance is not final are never counted.
import { cleanString } from '../utils/http.js';
import { isValidDateOnly } from '../utils/dates.js';

export const ACTIVITY_CATEGORIES = {
  community_development: 'Community Development',
  education_training: 'Educational and Training',
  meeting: 'Meeting',
};
export const ACTIVITY_STATUSES = ['scheduled', 'completed', 'cancelled'];
export const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'excused'];
export const ATTENDED_STATUSES = ['present', 'late'];
export const MAX_RECORDS_PER_SAVE = 500;

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

// '08:30' from '8:30', '08:30' or '08:30:00'; null when it is not a time of day.
export function parseClock(value) {
  const text = typeof value === 'string' ? value.trim().padStart(5, '0') : '';
  const match = CLOCK.exec(text);
  return match ? `${match[1]}:${match[2]}` : null;
}

// The activity form. `existing` is the activity being edited (null when new),
// `today` the cooperative's date (YYYY-MM-DD), `hasRecords` whether attendance
// was recorded for it.
export function validateActivityInput(body, { today, existing = null, hasRecords = false } = {}) {
  const errors = [];
  const values = {
    title: cleanString(body?.title, 200),
    category: cleanString(body?.category, 30),
    activityDate: cleanString(body?.activityDate, 10),
    startTime: parseClock(body?.startTime),
    endTime: parseClock(body?.endTime),
    venue: cleanString(body?.venue, 200),
    description: cleanString(body?.description, 2000),
    organizer: cleanString(body?.organizer, 200),
    status: cleanString(body?.status, 20) || existing?.status || 'scheduled',
    cancellationReason: cleanString(body?.cancellationReason, 500),
  };
  if (!values.title) errors.push('Activity title is required.');
  if (!ACTIVITY_CATEGORIES[values.category]) errors.push('Choose the category: Community Development, Educational and Training, or Meeting.');
  if (!isValidDateOnly(values.activityDate)) errors.push('A valid activity date is required.');
  if (!values.startTime) errors.push('A valid start time is required.');
  if (!values.endTime) errors.push('A valid end time is required.');
  if (values.startTime && values.endTime && values.endTime <= values.startTime) errors.push('The end time must be later than the start time.');
  if (!values.venue) errors.push('Venue is required.');
  if (!ACTIVITY_STATUSES.includes(values.status)) errors.push('Status must be scheduled, completed or cancelled.');
  if (errors.length) return { errors, values };

  const future = values.activityDate > today;
  const finalized = Boolean(existing?.attendance_finalized_at);
  if (!existing && values.status === 'cancelled') errors.push('A new activity is scheduled or completed. Cancel it later from its details if it does not take place.');
  if (values.status === 'completed' && future) errors.push('An activity on a future date cannot be completed yet.');
  if (finalized) {
    if (values.status !== 'completed') errors.push('Attendance for this activity is final, so it stays completed.');
    if (values.activityDate !== existing.activity_date) errors.push('Attendance for this activity is final, so its date cannot be changed.');
  } else if (hasRecords && future && values.activityDate !== existing?.activity_date) {
    errors.push('Attendance was already recorded for this activity, so it cannot move to a future date.');
  }
  if (values.status === 'cancelled' && existing?.status !== 'cancelled' && values.cancellationReason.length < 3) {
    errors.push('Give the reason the activity is cancelled.');
  }
  return { errors, values };
}

// The attendance rows sent by the Record Attendance list. Returns the rows to
// save (one per member) and the problems found.
export function parseAttendanceRecords(raw) {
  const errors = [];
  if (!Array.isArray(raw) || raw.length === 0) return { errors: ['Mark at least one member before saving.'], records: [] };
  if (raw.length > MAX_RECORDS_PER_SAVE) return { errors: [`Save at most ${MAX_RECORDS_PER_SAVE} members at a time.`], records: [] };
  const seen = new Set();
  const records = [];
  raw.forEach((item, index) => {
    const memberId = Number(item?.memberId);
    const status = cleanString(item?.status, 10);
    const row = `Row ${index + 1}`;
    if (!Number.isInteger(memberId) || memberId <= 0) { errors.push(`${row}: the member is missing.`); return; }
    if (seen.has(memberId)) { errors.push(`${row}: the same member is listed twice.`); return; }
    seen.add(memberId);
    if (!ATTENDANCE_STATUSES.includes(status)) { errors.push(`${row}: choose present, late, absent or excused.`); return; }
    const hasTime = item?.checkInTime !== undefined && item?.checkInTime !== null && item?.checkInTime !== '';
    const checkInTime = hasTime ? parseClock(item.checkInTime) : null;
    if (hasTime && !checkInTime) { errors.push(`${row}: the check-in time is not a valid time.`); return; }
    records.push({
      memberId,
      status,
      // Only members who came have a check-in time.
      checkInTime: ATTENDED_STATUSES.includes(status) ? checkInTime : null,
      remarks: cleanString(item?.remarks, 500),
    });
  });
  return { errors, records };
}

// Attended ÷ eligible × 100 with one decimal; null (shown as N/A) when the
// member had no eligible completed activity.
export function attendanceRate(attended, eligible) {
  const total = Number(eligible) || 0;
  if (total <= 0) return null;
  return Math.round((Number(attended) / total) * 1000) / 10;
}

function emptyCounts() {
  return { eligible: 0, attended: 0, present: 0, late: 0, absent: 0, excused: 0 };
}

function withRate(counts) {
  return { ...counts, rate: attendanceRate(counts.attended, counts.eligible) };
}

// Totals and the per-category breakdown from rows of
// { category, status, count } covering final, completed activities only.
export function summarizeParticipation(rows) {
  const total = emptyCounts();
  const byCategory = Object.fromEntries(Object.keys(ACTIVITY_CATEGORIES).map((category) => [category, emptyCounts()]));
  for (const row of rows) {
    const count = Number(row.count) || 0;
    if (!ATTENDANCE_STATUSES.includes(row.status) || !byCategory[row.category]) continue;
    for (const target of [total, byCategory[row.category]]) {
      target[row.status] += count;
      target.eligible += count;
      if (ATTENDED_STATUSES.includes(row.status)) target.attended += count;
    }
  }
  return {
    summary: withRate(total),
    byCategory: Object.entries(byCategory).map(([category, counts]) => ({ category, label: ACTIVITY_CATEGORIES[category], ...withRate(counts) })),
  };
}
