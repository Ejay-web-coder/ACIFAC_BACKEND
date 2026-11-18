import { describe, test, expect } from '@jest/globals';
import { validateActivityInput } from '../../src/services/attendance.js';

const TODAY = '2026-11-11';
const meeting = { title: 'General Assembly', category: 'meeting', activityDate: '2026-11-20', startTime: '8:00', endTime: '12:00', venue: 'ACIFAC Hall, Aliaga' };
const check = (body, options = {}) => validateActivityInput(body, { today: TODAY, ...options });

describe('Activity form (validateActivityInput: new activities)', () => {
  test('accepts a scheduled meeting for all members', () => {
    const { errors, values } = check(meeting);
    expect(errors).toEqual([]);
    expect(values).toMatchObject({ title: 'General Assembly', startTime: '08:00', endTime: '12:00', status: 'scheduled', attendeeScope: 'all' });
  });

  test('rejects an unknown category and an end time before the start time', () => {
    expect(check({ ...meeting, category: 'party' }).errors).toEqual(['Choose the category: Community Development, Educational and Training, or Meeting.']);
    expect(check({ ...meeting, startTime: '13:00', endTime: '09:00' }).errors).toEqual(['The end time must be later than the start time.']);
  });

  test('lists every required field that is blank', () => {
    expect(check({}).errors).toEqual([
      'Activity title is required.',
      'Choose the category: Community Development, Educational and Training, or Meeting.',
      'A valid activity date is required.',
      'A valid start time is required.',
      'A valid end time is required.',
      'Venue is required.',
    ]);
  });

  test('an activity for selected members needs at least one member', () => {
    expect(check({ ...meeting, attendeeScope: 'selected', memberIds: [] }).errors).toEqual(['Choose at least one member who must attend.']);
    const { errors, values } = check({ ...meeting, attendeeScope: 'selected', memberIds: [3, '5', 3] });
    expect(errors).toEqual([]);
    expect(values.memberIds).toEqual([3, 5]);
  });

  test('an activity on a future date cannot be marked completed', () => {
    expect(check({ ...meeting, status: 'completed' }).errors).toEqual(['An activity on a future date cannot be completed yet.']);
    expect(check({ ...meeting, activityDate: '2026-11-10', status: 'completed' }).errors).toEqual([]);
  });

  test('edge case: a new activity cannot be created already cancelled', () => {
    expect(check({ ...meeting, status: 'cancelled', cancellationReason: 'Typhoon' }).errors)
      .toEqual(['A new activity is scheduled or completed. Cancel it later from its details if it does not take place.']);
  });
});
