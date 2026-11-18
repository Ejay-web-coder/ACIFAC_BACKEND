import { describe, test, expect } from '@jest/globals';
import { reportWindow } from '../../src/services/philmechReport.js';
import { build } from '../helpers/philmech-fixtures.js';

const tractorOf = (report) => report.machines.find((machine) => machine.machineryId === 'M-006');

describe('PhilMech utilization report (reportWindow, buildPhilmechReport)', () => {
  test('the report covers the chosen months, leap years included', () => {
    expect(reportWindow(2026, 1, 7)).toEqual({ from: '2026-01-01', to: '2026-07-31', label: 'January–July 2026', monthsChosen: true });
    expect(reportWindow(2024, 2, 2).to).toBe('2024-02-29');
    expect(reportWindow(2026).label).toBe('January–December 2026');
  });

  test('lists the per-service machines with their implements', () => {
    const report = build();
    expect(report.machines.map((machine) => machine.machineryId)).toEqual(['M-005', 'M-006']);
    expect(tractorOf(report).implements).toEqual([{ id: 'M-004', name: 'Rotavator' }]);
  });

  test('the summary counts each farmer once and splits area and income', () => {
    const { summary } = tractorOf(build());
    expect(summary.farmers).toEqual({ member: 2, nonMember: 1, total: 3 });
    expect(summary.areaHa).toEqual({ member: '3.0000', nonMember: '2.0000', total: '5.0000' });
    expect(summary.grossIncome).toEqual({ collected: '7900.00', collectibles: '10600.00', total: '18500.00' });
  });

  test('cash flow: sources = beginning cash + inflows; net = sources - outflows', () => {
    const { cashFlow } = tractorOf(build());
    expect(cashFlow).toMatchObject({ beginningCash: '10000.00', totalInflows: '8400.00', totalSourceOfCash: '18400.00', totalOutflows: '7000.00', netCashFlow: '11400.00' });
  });

  test('records that make the paper report disagree are flagged', () => {
    const report = build();
    expect(tractorOf(report).warnings.map((warning) => warning.code)).toEqual(['SERVICE_OUTSIDE_MONTHS', 'FEE_CHANGED', 'UNPAID_NO_PAYMENT']);
    expect(report.machines[0].warnings.map((warning) => warning.code)).toEqual(['SERVICE_WITHOUT_AREA', 'NO_BEGINNING_CASH']);
  });

  test('edge case: summary totals that differ from the lists are errors', () => {
    const warnings = tractorOf(build({ 'M-006': { area: { member: '3.0000', non_member: '1.0000' }, expenses: '6500.00' } })).warnings;
    expect(warnings.slice(0, 2).map((warning) => warning.code)).toEqual(['AREA_MISMATCH', 'EXPENSE_MISMATCH']);
  });
});
