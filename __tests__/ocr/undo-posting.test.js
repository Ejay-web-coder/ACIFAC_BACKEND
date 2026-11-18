import { describe, test, expect } from '@jest/globals';
import { UNDO_WINDOW_HOURS, undoDeadline } from '../../src/services/documentRouting.js';

const AT = '2026-10-01T00:00:00.000Z';
const scan = (changes) => ({ posted_at: AT, posted_automatically: true, posted_module: 'members', ...changes });

describe('Undoing a scan saved automatically (undoDeadline)', () => {
  test('a member registered automatically can be undone for 48 hours', () => {
    expect(UNDO_WINDOW_HOURS).toBe(48);
    expect(undoDeadline(scan()).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });

  test('loan applications and rental requests saved automatically can be undone too', () => {
    expect(undoDeadline(scan({ posted_module: 'loans' }))).not.toBeNull();
    expect(undoDeadline(scan({ posted_module: 'machinery' }))).not.toBeNull();
  });

  test('a scan an administrator saved by hand cannot be undone here', () => {
    expect(undoDeadline(scan({ posted_automatically: false }))).toBeNull();
  });

  test('a scan that was never saved has nothing to undo', () => {
    expect(undoDeadline(scan({ posted_at: null }))).toBeNull();
  });

  test('edge case: savings recorded from a scan cannot be undone', () => {
    expect(undoDeadline(scan({ posted_module: 'savings' }))).toBeNull();
  });
});
