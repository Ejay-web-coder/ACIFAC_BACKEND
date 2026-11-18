import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { importMembers } = await import('../../src/controllers/memberController.js');

const row = (first, last) => ({ first_name: first, last_name: last, phone: '09171234567', address: 'Aliaga, Nueva Ecija', membership_date: '2026-01-15' });
// duplicateOf: the first name that the database already has.
function databaseHas({ duplicateOf = null } = {}) {
  let next = 1;
  answer(db.client.query, [
    ['SELECT id, member_number FROM members', (params) => ({ rows: params[4] === duplicateOf ? [{ id: 12, member_number: 'ACIFAC-2025-012' }] : [] })],
    ['AS next_number', () => ({ rows: [{ next_number: next++ }] })],
    ['INSERT INTO members', () => ({ rows: [{ id: 100 + next }] })],
  ]);
}
const upload = (rows) => mockRequest({ method: 'POST', body: { rows }, user: { id: 1, username: 'admin', role: 'ADMIN' } });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Import members from a spreadsheet (memberController.importMembers)', () => {
  test('imports every valid row and numbers them in order', async () => {
    const res = mockResponse();
    await importMembers(upload([row('Juan', 'Dela Cruz'), row('Maria', 'Santos')]), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('2 of 2 member(s) imported.');
    expect(res.body.data.results.map((result) => result.memberNumber)).toEqual([expect.stringMatching(/-001$/), expect.stringMatching(/-002$/)]);
  });

  test('a row with errors is reported and the other rows are still imported', async () => {
    const res = mockResponse();
    await importMembers(upload([row('Juan', 'Dela Cruz'), row('Maria', '')]), res);
    expect(res.body.message).toBe('1 of 2 member(s) imported.');
    expect(res.body.data).toMatchObject({ imported: 1, failed: 1 });
    expect(res.body.data.results[1]).toEqual({ row: 2, success: false, errors: ['Last name is required.'] });
  });

  test('a member already registered is skipped without undoing the others', async () => {
    databaseHas({ duplicateOf: 'Maria' });
    const res = mockResponse();
    await importMembers(upload([row('Juan', 'Dela Cruz'), row('Maria', 'Santos')]), res);
    expect(res.body.data.results[1].errors[0]).toMatch(/already registered \(ACIFAC-2025-012\)/);
    expect(db.client.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT member_import_row');
    expect(res.body.data.imported).toBe(1);
  });

  test('an empty upload is rejected', async () => {
    await expect(importMembers(upload([]), mockResponse())).rejects.toMatchObject({ status: 400, message: 'No member rows were provided.' });
    await expect(importMembers(mockRequest({ method: 'POST', body: {} }), mockResponse())).rejects.toMatchObject({ status: 400 });
  });

  test('edge case: more than 200 rows in one upload is refused', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => row(`Member${index}`, 'Test'));
    await expect(importMembers(upload(rows), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Import at most 200 members per request.' });
  });
});
