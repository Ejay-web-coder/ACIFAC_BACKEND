import { jest, describe, test, expect } from '@jest/globals';
import { nextMemberNumber } from '../../src/controllers/memberController.js';
import { todayDateOnly } from '../../src/utils/dates.js';

const year = todayDateOnly().slice(0, 4);
// A database stand-in that reports the next sequence number of this year.
const databaseWithNext = (next) => ({ query: jest.fn(async () => ({ rows: [{ next_number: next }] })) });

describe('Membership numbers (nextMemberNumber)', () => {
  test('the first member of the year is number 001', async () => {
    await expect(nextMemberNumber(databaseWithNext(1))).resolves.toBe(`ACIFAC-${year}-001`);
  });

  test('numbers are padded to three digits', async () => {
    await expect(nextMemberNumber(databaseWithNext(12))).resolves.toBe(`ACIFAC-${year}-012`);
  });

  test('only this year\'s ACIFAC numbers are counted', async () => {
    const db = databaseWithNext(5);
    await nextMemberNumber(db);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [`^ACIFAC-${year}-[0-9]+$`]);
  });

  test('edge case: the 1000th member gets a four-digit number, not a repeat', async () => {
    await expect(nextMemberNumber(databaseWithNext(1000))).resolves.toBe(`ACIFAC-${year}-1000`);
  });
});
