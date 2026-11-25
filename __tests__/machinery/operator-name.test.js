import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN, mockMemberEmails } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', mockEmailService);
jest.unstable_mockModule('../../src/services/memberEmails.js', mockMemberEmails);
const { setOperationOperator } = await import('../../src/controllers/machineryController.js');

const booking = { id: 9, machinery_name: 'Water Pump', member_name: 'Juan Dela Cruz', operator_name: null };
function databaseHas(row = booking) {
  answer(db.client.query, [
    ['SELECT id, machinery_name, member_name, operator_name FROM machinery_operations', { rows: row ? [row] : [] }],
    ['FROM machinery_operations o', { rows: [{ id: 9, operatorName: 'saved' }] }],
  ]);
}
const enter = (operatorName, id = 9) => mockRequest({ method: 'PATCH', params: { id: String(id) }, body: { operatorName }, user: ADMIN });
const saved = () => db.client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE machinery_operations SET operator_name'))?.[1];
const audit = () => db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'))?.[1] ?? [];
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Operator of a booking (machineryController.setOperationOperator)', () => {
  test('keeps the name without the spaces around it and returns the booking', async () => {
    const res = mockResponse();
    await setOperationOperator(enter('  Pedro Santos  '), res);
    expect(saved()).toEqual([9, 'Pedro Santos']);
    expect(res.body).toEqual({ success: true, operation: { id: 9, operatorName: 'saved' } });
    expect(audit()).toContain('Set Pedro Santos as operator of the Water Pump booking of Juan Dela Cruz');
  });

  test('a blank name removes the operator', async () => {
    databaseHas({ ...booking, operator_name: 'Pedro Santos' });
    for (const blank of ['', '   ', null, undefined]) {
      db.client.query.mockClear();
      await setOperationOperator(enter(blank), mockResponse());
      expect(saved()).toEqual([9, null]);
      expect(audit()).toContain('Removed the operator of the Water Pump booking of Juan Dela Cruz');
    }
  });

  test('a long name is cut at 200 characters', async () => {
    await setOperationOperator(enter('A'.repeat(250)), mockResponse());
    expect(saved()[1]).toHaveLength(200);
  });

  test('refuses what is not a name, and a booking that does not exist', async () => {
    for (const value of [42, true, ['Pedro'], { name: 'Pedro' }]) {
      await expect(setOperationOperator(enter(value), mockResponse())).rejects.toMatchObject({ status: 400, message: 'The operator must be a name.' });
    }
    await expect(setOperationOperator(enter('Pedro', 'abc'), mockResponse())).rejects.toMatchObject({ status: 400 });
    databaseHas(null);
    await expect(setOperationOperator(enter('Pedro'), mockResponse())).rejects.toMatchObject({ status: 404, message: 'Operation not found.' });
    expect(saved()).toBeUndefined();
  });
});
