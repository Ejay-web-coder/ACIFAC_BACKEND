import { describe, test, expect } from '@jest/globals';
import { MAX_RECORDS_PER_SAVE, parseAttendanceRecords } from '../../src/services/attendance.js';

describe('Recording attendance (parseAttendanceRecords)', () => {
  test('accepts one row per member with a valid status and check-in time', () => {
    const { errors, records } = parseAttendanceRecords([
      { memberId: 3, status: 'present', checkInTime: '7:55' },
      { memberId: 4, status: 'late', checkInTime: '08:20:00', remarks: 'Came from the field' },
      { memberId: 5, status: 'excused' },
    ]);
    expect(errors).toEqual([]);
    expect(records).toEqual([
      { memberId: 3, status: 'present', checkInTime: '07:55', remarks: '' },
      { memberId: 4, status: 'late', checkInTime: '08:20', remarks: 'Came from the field' },
      { memberId: 5, status: 'excused', checkInTime: null, remarks: '' },
    ]);
  });

  test('rejects an unknown status and an impossible check-in time, row by row', () => {
    const { errors, records } = parseAttendanceRecords([
      { memberId: 3, status: 'sleeping' },
      { memberId: 4, status: 'present', checkInTime: '25:00' },
      { memberId: 5, status: 'present' },
    ]);
    expect(errors).toEqual(['Row 1: choose present, late, absent or excused.', 'Row 2: the check-in time is not a valid time.']);
    expect(records.map((row) => row.memberId)).toEqual([5]);
  });

  test('an empty list, or a row without a member, is refused', () => {
    expect(parseAttendanceRecords([]).errors).toEqual(['Mark at least one member before saving.']);
    expect(parseAttendanceRecords(undefined).errors).toEqual(['Mark at least one member before saving.']);
    expect(parseAttendanceRecords([{ status: 'present' }]).errors).toEqual(['Row 1: the member is missing.']);
  });

  test('the same member cannot be listed twice', () => {
    expect(parseAttendanceRecords([{ memberId: 3, status: 'present' }, { memberId: 3, status: 'absent' }]).errors).toEqual(['Row 2: the same member is listed twice.']);
  });

  test('members who did not come never keep a check-in time', () => {
    expect(parseAttendanceRecords([{ memberId: 3, status: 'absent', checkInTime: '08:00' }]).records[0].checkInTime).toBeNull();
  });

  test(`edge case: at most ${MAX_RECORDS_PER_SAVE} members are saved at a time`, () => {
    const rows = Array.from({ length: MAX_RECORDS_PER_SAVE + 1 }, (_, index) => ({ memberId: index + 1, status: 'present' }));
    expect(parseAttendanceRecords(rows).errors).toEqual([`Save at most ${MAX_RECORDS_PER_SAVE} members at a time.`]);
  });
});
