import { describe, test, expect } from '@jest/globals';
import { MAX_INVITEES, validateActivityInput } from '../../src/services/attendance.js';

const TODAY = '2026-11-11';
const saved = { status: 'scheduled', activity_date: '2026-11-05', attendee_scope: 'all', attendance_finalized_at: null };
const finalized = { ...saved, status: 'completed', attendance_finalized_at: '2026-11-05T09:00:00Z' };
const edit = (changes, existing = saved, hasRecords = false) => validateActivityInput(
  { title: 'Rice Production Training', category: 'education_training', activityDate: '2026-11-05', startTime: '08:00', endTime: '16:00', venue: 'Barangay Hall', ...changes },
  { today: TODAY, existing, hasRecords },
);

describe('Activity changes (validateActivityInput: editing and cancelling)', () => {
  test('a finalized activity keeps its date, status and attendees', () => {
    expect(edit({ status: 'completed' }, finalized).errors).toEqual([]);
    expect(edit({ status: 'completed', activityDate: '2026-11-06' }, finalized).errors).toEqual(['Attendance for this activity is final, so its date cannot be changed.']);
    expect(edit({ status: 'scheduled' }, finalized).errors).toEqual(['Attendance for this activity is final, so it stays completed.']);
  });

  test('cancelling an activity needs a reason', () => {
    expect(edit({ status: 'cancelled', cancellationReason: '' }).errors).toEqual(['Give the reason the activity is cancelled.']);
    expect(edit({ status: 'cancelled', cancellationReason: 'Typhoon signal no. 2' }).errors).toEqual([]);
  });

  test('an activity with recorded attendance cannot move to a future date', () => {
    expect(edit({ activityDate: '2026-11-25' }, saved, true).errors).toEqual(['Attendance was already recorded for this activity, so it cannot move to a future date.']);
    expect(edit({ activityDate: '2026-11-25' }, saved, false).errors).toEqual([]);
  });

  test('the list of members who must attend is checked', () => {
    expect(edit({ attendeeScope: 'selected', memberIds: 'all of them' }).errors).toContain('The members who must attend are not a list.');
    expect(edit({ attendeeScope: 'selected', memberIds: [3, -1] }).errors).toContain('Some of the members who must attend are not valid.');
  });

  test('an edit may keep the members already chosen', () => {
    expect(edit({ attendeeScope: 'selected' }, { ...saved, attendee_scope: 'selected' }).errors).toEqual([]);
  });

  test(`edge case: more than ${MAX_INVITEES} members cannot be invited`, () => {
    const memberIds = Array.from({ length: MAX_INVITEES + 1 }, (_, index) => index + 1);
    expect(edit({ attendeeScope: 'selected', memberIds }).errors).toContain(`Choose at most ${MAX_INVITEES} members.`);
  });
});
