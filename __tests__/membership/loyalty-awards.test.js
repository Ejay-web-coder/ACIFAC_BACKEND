import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { getLoyaltyReport } = await import('../../src/controllers/memberController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

const rows = [
  { id: 3, member_number: 'ACIFAC-2004-001', full_name: 'Juan Dela Cruz', membership_date: '2004-03-04', barangay: 'Barahan', municipality: 'Sta. Cruz', years: 22, eligible: 4, attended: 4, late_payments: 0, overdue_loans: 0 },
  { id: 9, member_number: 'ACIFAC-2026-010', full_name: 'Ana Santos', membership_date: '2026-01-15', barangay: null, municipality: null, years: 0, eligible: 4, attended: 1, late_payments: 1, overdue_loans: 0 },
];
const request = (query = {}) => mockRequest({ query, user: { id: 1, username: 'admin', role: 'ADMIN' } });
beforeEach(() => { jest.clearAllMocks(); answer(db.module.query, [['FROM members m', { rows }]]); });

describe('Loyalty awards report (getLoyaltyReport)', () => {
  test('lists active members with their full years of membership on the award date', async () => {
    const res = mockResponse();
    await getLoyaltyReport(request({ asOf: '2026-11-19' }), res);
    expect(res.body).toEqual({
      success: true,
      data: {
        asOf: '2026-11-19',
        minAttendance: 75,
        members: [
          { id: 3, memberNumber: 'ACIFAC-2004-001', name: 'Juan Dela Cruz', membershipDate: '2004-03-04', years: 22, barangay: 'Barahan', municipality: 'Sta. Cruz',
            standing: { goodStanding: true, attendanceRate: 100, attended: 4, eligible: 4, latePayments: 0, overdueLoans: 0, reasons: [] } },
          { id: 9, memberNumber: 'ACIFAC-2026-010', name: 'Ana Santos', membershipDate: '2026-01-15', years: 0, barangay: '', municipality: '',
            standing: { goodStanding: false, attendanceRate: 25, attended: 1, eligible: 4, latePayments: 1, overdueLoans: 0, reasons: ['Attended 1 of 4 activities (25%, 75% needed)', '1 late loan payment'] } },
        ],
      },
    });
    const [sql, params] = db.module.query.mock.calls[0];
    expect(params).toEqual(['2026-11-19']);
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain('m.membership_date <= $1::date');
    expect(sql).toContain('age($1::date::timestamp, m.membership_date::timestamp)');
  });

  test('counts to today when no award date is given', async () => {
    const res = mockResponse();
    await getLoyaltyReport(request(), res);
    expect(res.body.data.asOf).toBe(todayDateOnly());
    expect(db.module.query.mock.calls[0][1]).toEqual([todayDateOnly()]);
  });

  test('good standing: the attendance needed can be changed, from 0 to 100 percent', async () => {
    const res = mockResponse();
    await getLoyaltyReport(request({ asOf: '2026-11-19', minAttendance: '20' }), res);
    expect(res.body.data.minAttendance).toBe(20);
    expect(res.body.data.members[1].standing.reasons).toEqual(['1 late loan payment']);
    for (const minAttendance of ['-1', '101', '7.5', 'most']) {
      await expect(getLoyaltyReport(request({ asOf: '2026-11-19', minAttendance }), mockResponse())).rejects.toMatchObject({ status: 400 });
    }
  });

  test('an award date that is not a real calendar date is refused', async () => {
    for (const asOf of ['2026-02-30', '19/11/2026', 'today']) {
      await expect(getLoyaltyReport(request({ asOf }), mockResponse()))
        .rejects.toMatchObject({ status: 400, message: 'The award date must be a valid date (YYYY-MM-DD).' });
    }
    expect(db.module.query).not.toHaveBeenCalled();
  });
});
