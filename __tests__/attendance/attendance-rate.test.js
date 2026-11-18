import { describe, test, expect } from '@jest/globals';
import { attendanceRate, summarizeParticipation } from '../../src/services/attendance.js';

describe('Attendance rate and participation (attendanceRate, summarizeParticipation)', () => {
  test('the rate is activities attended over eligible activities, to one decimal', () => {
    expect(attendanceRate(7, 8)).toBe(87.5);
    expect(attendanceRate(2, 3)).toBe(66.7);
    expect(attendanceRate('10', '10')).toBe(100);
  });

  test('a member with no eligible activity has no rate (shown as N/A)', () => {
    expect(attendanceRate(0, 0)).toBeNull();
    expect(attendanceRate(0, undefined)).toBeNull();
  });

  test('present and late count as attended; absent and excused do not', () => {
    const { summary } = summarizeParticipation([
      { category: 'meeting', status: 'present', count: 6 },
      { category: 'meeting', status: 'late', count: 2 },
      { category: 'meeting', status: 'absent', count: 1 },
      { category: 'meeting', status: 'excused', count: 1 },
    ]);
    expect(summary).toEqual({ eligible: 10, attended: 8, present: 6, late: 2, absent: 1, excused: 1, rate: 80 });
  });

  test('each category gets its own counts and rate', () => {
    const { byCategory } = summarizeParticipation([
      { category: 'meeting', status: 'present', count: 3 },
      { category: 'education_training', status: 'absent', count: 1 },
      { category: 'education_training', status: 'present', count: 1 },
    ]);
    expect(byCategory.map(({ category, label, rate }) => ({ category, label, rate }))).toEqual([
      { category: 'community_development', label: 'Community Development', rate: null },
      { category: 'education_training', label: 'Educational and Training', rate: 50 },
      { category: 'meeting', label: 'Meeting', rate: 100 },
    ]);
  });

  test('edge case: rows with an unknown status or category are ignored', () => {
    const { summary } = summarizeParticipation([{ category: 'meeting', status: 'present', count: 1 }, { category: 'party', status: 'present', count: 9 }, { category: 'meeting', status: 'asleep', count: 9 }]);
    expect(summary).toMatchObject({ eligible: 1, attended: 1, rate: 100 });
  });
});
