import { describe, test, expect } from '@jest/globals';
import { parseClock } from '../../src/services/attendance.js';

describe('Times of day (parseClock)', () => {
  test('reads times written in the usual ways as HH:MM', () => {
    expect(parseClock('8:30')).toBe('08:30');
    expect(parseClock('08:30')).toBe('08:30');
    expect(parseClock('08:30:45')).toBe('08:30');
    expect(parseClock(' 23:59 ')).toBe('23:59');
  });

  test('rejects hours and minutes that do not exist', () => {
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
  });

  test('rejects blank or missing times', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });

  test('edge case: text and numbers that are not a time are rejected', () => {
    expect(parseClock('8 AM')).toBeNull();
    expect(parseClock(830)).toBeNull();
  });
});
