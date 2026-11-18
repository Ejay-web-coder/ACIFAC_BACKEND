// The machines, services, expenses and rates of the PhilMech report test case (as in test/philmech-report.test.js).
import { buildPhilmechReport } from '../../src/services/philmechReport.js';

export const machines = [
  { id: 'M-004', name: 'Rotavator', type: 'Tractor', pricingMode: 'per_day', parentMachineryId: 'M-006' },
  { id: 'M-003', name: 'Water Pump', type: 'Irrigation', pricingMode: 'per_day', parentMachineryId: null },
  { id: 'M-005', name: 'Harvester', type: 'Harvester', pricingMode: 'per_service', parentMachineryId: null, deliveryDate: '2020-12-08', condition: 'operational' },
  { id: 'M-006', name: 'Tractor with Rotavator', type: 'Tractor', pricingMode: 'per_service', parentMachineryId: null, deliveryDate: '2025-02-21', condition: 'always_repair' },
];

const service = (overrides) => ({
  reportMachineId: 'M-006', machineryId: 'M-006', unit: 'per_ha', clientAddress: 'Amnay', memberId: null, totalBags: null, feeBags: null,
  computedFeeAmount: null, feeOverrideReason: null, paymentCount: 1, ...overrides,
});

export const services = [
  service({ id: 1, serviceType: 'Rotavator', serviceDate: '2026-06-10', clientCategory: 'member', memberId: 7, clientName: 'Maruja Galope', areaHa: '1.5000', rateUsed: '3800.00', feeAmount: '5700.00', amountPaid: '4000.00', balance: '1700.00', paymentStatus: 'partial' }),
  service({ id: 2, serviceType: 'Squadrone', serviceDate: '2026-06-11', clientCategory: 'member', memberId: 8, clientName: 'Eleseo Acosta', areaHa: '1.0000', rateUsed: '3400.00', feeAmount: '3400.00', amountPaid: '2000.00', balance: '1400.00', paymentStatus: 'partial' }),
  service({ id: 3, serviceType: 'Rotavator', serviceDate: '2026-06-12', clientCategory: 'member', memberId: 7, clientName: 'Maruja Galope', areaHa: '0.5000', rateUsed: '3800.00', feeAmount: '1900.00', amountPaid: '1900.00', balance: '0.00', paymentStatus: 'full' }),
  service({ id: 4, serviceType: 'Rotavator', serviceDate: '2026-08-02', clientCategory: 'non_member', clientName: 'Pedro Santos', clientAddress: 'Calintaan', areaHa: '2.0000', rateUsed: '4000.00', computedFeeAmount: '8000.00', feeAmount: '7500.00', feeOverrideReason: 'Discount approved by the board', amountPaid: '0.00', balance: '7500.00', paymentStatus: 'unpaid', paymentCount: 0 }),
  service({ id: 5, reportMachineId: 'M-005', machineryId: 'M-005', unit: 'per_100_bags', serviceType: 'Harvesting', serviceDate: '2026-03-03', clientCategory: 'non_member', clientName: 'Rosa Reyes', areaHa: '0', totalBags: '100.00', feeBags: '12.00', rateUsed: '12.00', feeAmount: '8400.00', amountPaid: '8400.00', balance: '0.00', paymentStatus: 'full' }),
];

export const expenses = [
  { reportMachineId: 'M-006', id: 1, expenseDate: '2026-06-01', category: 'fuel', amount: '2500.00' },
  { reportMachineId: 'M-006', id: 2, expenseDate: '2026-06-05', category: 'labor', amount: '1500.00' },
  { reportMachineId: 'M-006', id: 3, expenseDate: '2026-05-20', category: 'repair_maintenance', amount: '3000.00' },
];

export const build = (aggregates = { 'M-006': { area: { member: '3.0000', non_member: '2.0000' }, expenses: '7000.00' }, 'M-005': { area: { non_member: '0' }, expenses: '0' } }) => buildPhilmechReport({
  croppingPeriod: '1st', year: 2026, fromMonth: 1, toMonth: 7, machines, services, expenses,
  balances: [{ reportMachineId: 'M-006', machineryId: 'M-006', beginningCash: '10000.00', otherIncome: '500.00' }],
  rates: [
    { reportMachineId: 'M-006', serviceType: 'Rotavator', unit: 'per_ha', memberRate: '3800.00', nonMemberRate: '4000.00', effectiveFrom: '2026-05-01', effectiveTo: null },
    { reportMachineId: 'M-006', serviceType: 'Rotavator', unit: 'per_ha', memberRate: '2000.00', nonMemberRate: '2000.00', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
  ],
  aggregates,
});
