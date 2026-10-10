// Unit tests for the attendance rules (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceRate, parseAttendanceRecords, parseClock, summarizeParticipation, validateActivityInput } from '../src/services/attendance.js';

const TODAY = '2026-10-10';
const activity = (overrides = {}) => ({
  title: 'General Assembly', category: 'meeting', activityDate: '2026-10-20', startTime: '08:00', endTime: '12:00', venue: 'ACIFAC Hall', ...overrides,
});

test('attendance rate: present and late over eligible completed activities, N/A without any', () => {
  assert.equal(attendanceRate(3, 4), 75);
  assert.equal(attendanceRate(2, 3), 66.7);
  assert.equal(attendanceRate(0, 5), 0);
  assert.equal(attendanceRate(5, 5), 100);
  assert.equal(attendanceRate(0, 0), null);
});

test('participation summary: present and late are attended, absent and excused are counted apart, per category', () => {
  const { summary, byCategory } = summarizeParticipation([
    { category: 'meeting', status: 'present', count: 2 },
    { category: 'meeting', status: 'late', count: 1 },
    { category: 'meeting', status: 'absent', count: 1 },
    { category: 'education_training', status: 'excused', count: 1 },
    { category: 'community_development', status: 'present', count: 1 },
    { category: 'unknown', status: 'present', count: 9 },
  ]);
  assert.deepEqual(summary, { eligible: 6, attended: 4, present: 3, late: 1, absent: 1, excused: 1, rate: 66.7 });
  const meeting = byCategory.find((row) => row.category === 'meeting');
  assert.deepEqual({ eligible: meeting.eligible, attended: meeting.attended, rate: meeting.rate }, { eligible: 4, attended: 3, rate: 75 });
  assert.equal(byCategory.find((row) => row.category === 'education_training').rate, 0);
  assert.equal(byCategory.find((row) => row.category === 'community_development').label, 'Community Development');
  assert.equal(summarizeParticipation([]).summary.rate, null);
});

test('activity form: required fields and the end time after the start time', () => {
  assert.deepEqual(validateActivityInput(activity(), { today: TODAY }).errors, []);
  const empty = validateActivityInput({}, { today: TODAY }).errors;
  assert.ok(empty.includes('Activity title is required.'));
  assert.ok(empty.includes('Venue is required.'));
  assert.ok(empty.some((error) => /category/.test(error)));
  assert.deepEqual(validateActivityInput(activity({ endTime: '08:00' }), { today: TODAY }).errors, ['The end time must be later than the start time.']);
  assert.deepEqual(validateActivityInput(activity({ endTime: '07:30' }), { today: TODAY }).errors, ['The end time must be later than the start time.']);
  assert.ok(validateActivityInput(activity({ activityDate: '2026-02-30' }), { today: TODAY }).errors.length);
  assert.ok(validateActivityInput(activity({ startTime: '25:00' }), { today: TODAY }).errors.length);
  assert.equal(validateActivityInput(activity({ startTime: '8:00' }), { today: TODAY }).values.startTime, '08:00');
});

test('activity form: status rules for new, future, final and cancelled activities', () => {
  assert.match(validateActivityInput(activity({ status: 'completed' }), { today: TODAY }).errors[0], /future date cannot be completed/);
  assert.deepEqual(validateActivityInput(activity({ status: 'completed', activityDate: TODAY }), { today: TODAY }).errors, []);
  assert.match(validateActivityInput(activity({ status: 'cancelled' }), { today: TODAY }).errors[0], /new activity/);

  const existing = { status: 'scheduled', activity_date: '2026-10-05', attendance_finalized_at: null };
  assert.match(validateActivityInput(activity({ status: 'cancelled' }), { today: TODAY, existing }).errors[0], /reason/);
  assert.deepEqual(validateActivityInput(activity({ status: 'cancelled', cancellationReason: 'Typhoon' }), { today: TODAY, existing }).errors, []);
  assert.match(validateActivityInput(activity(), { today: TODAY, existing, hasRecords: true }).errors[0], /cannot move to a future date/);
  assert.deepEqual(validateActivityInput(activity(), { today: TODAY, existing, hasRecords: false }).errors, []);

  const final = { status: 'completed', activity_date: '2026-10-05', attendance_finalized_at: new Date() };
  assert.deepEqual(validateActivityInput(activity({ activityDate: '2026-10-05', status: 'completed', venue: 'Barangay Hall' }), { today: TODAY, existing: final }).errors, []);
  assert.ok(validateActivityInput(activity({ activityDate: '2026-10-04', status: 'completed' }), { today: TODAY, existing: final }).errors.some((error) => /date cannot be changed/.test(error)));
  assert.ok(validateActivityInput(activity({ activityDate: '2026-10-05', status: 'scheduled' }), { today: TODAY, existing: final }).errors.some((error) => /stays completed/.test(error)));
});

test('attendance rows: one per member, known statuses, check-in only for members who came', () => {
  assert.deepEqual(parseAttendanceRecords([]).errors, ['Mark at least one member before saving.']);
  assert.match(parseAttendanceRecords([{ memberId: 1, status: 'present' }, { memberId: 1, status: 'late' }]).errors[0], /listed twice/);
  assert.match(parseAttendanceRecords([{ memberId: 1, status: 'here' }]).errors[0], /present, late, absent or excused/);
  assert.match(parseAttendanceRecords([{ memberId: 0, status: 'present' }]).errors[0], /member is missing/);
  assert.match(parseAttendanceRecords([{ memberId: 1, status: 'late', checkInTime: '8:75' }]).errors[0], /check-in time/);
  const { errors, records } = parseAttendanceRecords([
    { memberId: 1, status: 'late', checkInTime: '08:15', remarks: '  Came by tricycle ' },
    { memberId: '2', status: 'absent', checkInTime: '08:00' },
    { memberId: 3, status: 'excused', remarks: 'Sick' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(records, [
    { memberId: 1, status: 'late', checkInTime: '08:15', remarks: 'Came by tricycle' },
    { memberId: 2, status: 'absent', checkInTime: null, remarks: '' },
    { memberId: 3, status: 'excused', checkInTime: null, remarks: 'Sick' },
  ]);
  assert.match(parseAttendanceRecords(Array.from({ length: 501 }, (_, index) => ({ memberId: index + 1, status: 'present' }))).errors[0], /at most 500/);
});

test('clock times', () => {
  assert.equal(parseClock('07:05'), '07:05');
  assert.equal(parseClock('7:05'), '07:05');
  assert.equal(parseClock('23:59:59'), '23:59');
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(undefined), null);
});
