import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhilmechReport, reportWindow } from '../src/services/philmechReport.js';

const machines = [
  { id: 'M-004', name: 'Rotavator', type: 'Tractor', pricingMode: 'per_day', parentMachineryId: 'M-006' },
  { id: 'M-003', name: 'Water Pump', type: 'Irrigation', pricingMode: 'per_day', parentMachineryId: null },
  { id: 'M-005', name: 'Harvester', type: 'Harvester', pricingMode: 'per_service', parentMachineryId: null, deliveryDate: '2020-12-08', condition: 'operational' },
  { id: 'M-006', name: 'Tractor with Rotavator', type: 'Tractor', pricingMode: 'per_service', parentMachineryId: null, deliveryDate: '2025-02-21', condition: 'always_repair' },
];

const service = (overrides) => ({
  reportMachineId: 'M-006', machineryId: 'M-006', unit: 'per_ha', clientAddress: 'Amnay', memberId: null, totalBags: null, feeBags: null,
  computedFeeAmount: null, feeOverrideReason: null, paymentCount: 1, ...overrides,
});

const services = [
  service({ id: 1, serviceType: 'Rotavator', serviceDate: '2026-06-10', clientCategory: 'member', memberId: 7, clientName: 'Maruja Galope', areaHa: '1.5000', rateUsed: '3800.00', feeAmount: '5700.00', amountPaid: '4000.00', balance: '1700.00', paymentStatus: 'partial' }),
  service({ id: 2, serviceType: 'Squadrone', serviceDate: '2026-06-11', clientCategory: 'member', memberId: 8, clientName: 'Eleseo Acosta', areaHa: '1.0000', rateUsed: '3400.00', feeAmount: '3400.00', amountPaid: '2000.00', balance: '1400.00', paymentStatus: 'partial' }),
  service({ id: 3, serviceType: 'Rotavator', serviceDate: '2026-06-12', clientCategory: 'member', memberId: 7, clientName: 'Maruja Galope', areaHa: '0.5000', rateUsed: '3800.00', feeAmount: '1900.00', amountPaid: '1900.00', balance: '0.00', paymentStatus: 'full' }),
  service({ id: 4, serviceType: 'Rotavator', serviceDate: '2026-08-02', clientCategory: 'non_member', clientName: 'Pedro Santos', clientAddress: 'Calintaan', areaHa: '2.0000', rateUsed: '4000.00', computedFeeAmount: '8000.00', feeAmount: '7500.00', feeOverrideReason: 'Discount approved by the board', amountPaid: '0.00', balance: '7500.00', paymentStatus: 'unpaid', paymentCount: 0 }),
  service({ id: 5, reportMachineId: 'M-005', machineryId: 'M-005', unit: 'per_100_bags', serviceType: 'Harvesting', serviceDate: '2026-03-03', clientCategory: 'non_member', clientName: 'Rosa Reyes', areaHa: '0', totalBags: '100.00', feeBags: '12.00', rateUsed: '12.00', feeAmount: '8400.00', amountPaid: '8400.00', balance: '0.00', paymentStatus: 'full' }),
];

const expenses = [
  { reportMachineId: 'M-006', id: 1, expenseDate: '2026-06-01', category: 'fuel', amount: '2500.00' },
  { reportMachineId: 'M-006', id: 2, expenseDate: '2026-06-05', category: 'labor', amount: '1500.00' },
  { reportMachineId: 'M-006', id: 3, expenseDate: '2026-05-20', category: 'repair_maintenance', amount: '3000.00' },
];

const build = (aggregates = { 'M-006': { area: { member: '3.0000', non_member: '2.0000' }, expenses: '7000.00' }, 'M-005': { area: { non_member: '0' }, expenses: '0' } }) => buildPhilmechReport({
  croppingPeriod: '1st', year: 2026, fromMonth: 1, toMonth: 7, machines, services, expenses,
  balances: [{ reportMachineId: 'M-006', machineryId: 'M-006', beginningCash: '10000.00', otherIncome: '500.00' }],
  rates: [
    { reportMachineId: 'M-006', serviceType: 'Rotavator', unit: 'per_ha', memberRate: '3800.00', nonMemberRate: '4000.00', effectiveFrom: '2026-05-01', effectiveTo: null },
    { reportMachineId: 'M-006', serviceType: 'Rotavator', unit: 'per_ha', memberRate: '2000.00', nonMemberRate: '2000.00', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
  ],
  aggregates,
});

test('report window covers the chosen months inclusively', () => {
  assert.deepEqual(reportWindow(2026, 1, 7), { from: '2026-01-01', to: '2026-07-31', label: 'January–July 2026', monthsChosen: true });
  assert.equal(reportWindow(2024, 2, 2).to, '2024-02-29');
  assert.equal(reportWindow(2026).label, 'January–December 2026');
});

test('machines: per-service machines and machines with records, implements under their tractor', () => {
  const report = build();
  assert.deepEqual(report.machines.map((machine) => machine.machineryId), ['M-005', 'M-006']);
  const tractor = report.machines.find((machine) => machine.machineryId === 'M-006');
  assert.deepEqual(tractor.implements, [{ id: 'M-004', name: 'Rotavator' }]);
  assert.equal(tractor.rates.length, 1, 'only rates in effect during the report months are listed');
});

test('utilization summary counts farmers once and splits area and income', () => {
  const tractor = build().machines.find((machine) => machine.machineryId === 'M-006');
  assert.deepEqual(tractor.summary.farmers, { member: 2, nonMember: 1, total: 3 });
  assert.deepEqual(tractor.summary.areaHa, { member: '3.0000', nonMember: '2.0000', total: '5.0000' });
  assert.deepEqual(tractor.summary.grossIncome, { collected: '7900.00', collectibles: '10600.00', total: '18500.00' });
  assert.equal(tractor.summary.operatingExpenses, '7000.00');
  assert.equal(tractor.summary.availableFunds, '11500.00');
});

test('cash flow: c = a + b and net = c - d', () => {
  const { cashFlow } = build().machines.find((machine) => machine.machineryId === 'M-006');
  assert.equal(cashFlow.beginningCash, '10000.00');
  assert.equal(cashFlow.totalInflows, '8400.00');
  assert.equal(cashFlow.totalSourceOfCash, '18400.00');
  assert.deepEqual(cashFlow.outflows, { fuel: '2500.00', labor: '1500.00', repair_maintenance: '3000.00', other: '0.00' });
  assert.equal(cashFlow.totalOutflows, '7000.00');
  assert.equal(cashFlow.netCashFlow, '11400.00');
});

test('client list totals match the summary', () => {
  const tractor = build().machines.find((machine) => machine.machineryId === 'M-006');
  assert.equal(tractor.clients.length, 4);
  assert.equal(tractor.clients[0].name, 'Maruja Galope');
  assert.equal(tractor.clients[0].category, 'M');
  assert.equal(tractor.clients[3].category, 'NM');
  assert.deepEqual(tractor.clientTotals, { areaHa: '5.0000', totalAmount: '18500.00', cashCollection: '7900.00', accountsReceivable: '10600.00' });
});

test('warnings flag what made the paper report disagree', () => {
  const report = build();
  const codes = (id) => report.machines.find((machine) => machine.machineryId === id).warnings.map((warning) => warning.code);
  assert.deepEqual(codes('M-006'), ['SERVICE_OUTSIDE_MONTHS', 'FEE_CHANGED', 'UNPAID_NO_PAYMENT']);
  assert.deepEqual(codes('M-005'), ['SERVICE_WITHOUT_AREA', 'NO_BEGINNING_CASH']);
  const outside = report.machines[1].warnings[0].message;
  assert.match(outside, /Pedro Santos \(2026-08-02\)/);
  assert.match(outside, /January–July 2026/);
});

test('summary area and expenses that disagree with the lists are errors', () => {
  const report = build({ 'M-006': { area: { member: '3.0000', non_member: '1.0000' }, expenses: '6500.00' } });
  const warnings = report.machines.find((machine) => machine.machineryId === 'M-006').warnings;
  assert.equal(warnings[0].code, 'AREA_MISMATCH');
  assert.match(warnings[0].message, /4\.0000 ha.*5\.0000 ha/);
  assert.equal(warnings[1].code, 'EXPENSE_MISMATCH');
  assert.match(warnings[1].message, /₱6,500\.00.*₱7,000\.00/);
});
