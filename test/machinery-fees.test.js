import test from 'node:test';
import assert from 'node:assert/strict';
import { computeServiceFee, FeeInputError, findRateForDate, paymentSummary, rateForClient } from '../src/services/machineryFees.js';

// The rates seeded by sql/017 for the tractor and the harvester.
const tractorRates = [
  { serviceType: 'Rotavator', unit: 'per_ha', memberRate: '2800.00', nonMemberRate: '2800.00', effectiveFrom: '2026-01-01', effectiveTo: '2026-04-30' },
  { serviceType: 'Rotavator', unit: 'per_ha', memberRate: '3800.00', nonMemberRate: '4000.00', effectiveFrom: '2026-05-01', effectiveTo: null },
  { serviceType: 'Squadrone', unit: 'per_ha', memberRate: '3500.00', nonMemberRate: '3500.00', effectiveFrom: '2026-04-01', effectiveTo: '2026-04-30' },
  { serviceType: 'Squadrone', unit: 'per_ha', memberRate: '3400.00', nonMemberRate: '3400.00', effectiveFrom: '2026-05-01', effectiveTo: null },
  { serviceType: 'Tudling', unit: 'per_ha', memberRate: '1800.00', nonMemberRate: '1800.00', effectiveFrom: '2026-01-01', effectiveTo: null },
];
const harvestRate = { serviceType: 'Harvesting', unit: 'per_100_bags', memberRate: '10.00', nonMemberRate: '12.00', effectiveFrom: '2020-12-08', effectiveTo: null };

function perHectareFee(serviceType, serviceDate, clientCategory, areaHa) {
  const rate = findRateForDate(tractorRates, serviceType, serviceDate);
  return computeServiceFee({ unit: rate.unit, rate: rateForClient(rate, clientCategory), areaHa });
}

test('report case: Maruja Galope, Rotavator, member, 1.5 ha on 2026-06-10', () => {
  const fee = perHectareFee('Rotavator', '2026-06-10', 'member', '1.5');
  assert.equal(fee.rateUsed, '3800.00');
  assert.equal(fee.feeAmount, '5700.00');
  assert.deepEqual(paymentSummary(fee.feeAmount, '4000'), { balance: '1700.00', paymentStatus: 'partial' });
});

test('report case: Eleseo Acosta, Squadrone, 1 ha on 2026-06-11', () => {
  const fee = perHectareFee('Squadrone', '2026-06-11', 'member', 1);
  assert.equal(fee.feeAmount, '3400.00');
  assert.deepEqual(paymentSummary(fee.feeAmount, '2000.00'), { balance: '1400.00', paymentStatus: 'partial' });
});

test('report case: harvest of 100 bags is 10 bags for a member and 12 for a non-member', () => {
  const member = computeServiceFee({ unit: 'per_100_bags', rate: rateForClient(harvestRate, 'member'), totalBags: 100, bagValue: '1000' });
  const nonMember = computeServiceFee({ unit: 'per_100_bags', rate: rateForClient(harvestRate, 'non_member'), totalBags: 100, bagValue: '1000' });
  assert.equal(member.feeBags, '10.00');
  assert.equal(member.feeAmount, '10000.00');
  assert.equal(nonMember.feeBags, '12.00');
  assert.equal(nonMember.feeAmount, '12000.00');
});

test('the rate valid on the service date is used when rates change mid-season', () => {
  assert.equal(perHectareFee('Rotavator', '2026-04-30', 'member', 1).feeAmount, '2800.00');
  assert.equal(perHectareFee('Rotavator', '2026-04-30', 'non_member', 1).feeAmount, '2800.00');
  assert.equal(perHectareFee('Rotavator', '2026-05-01', 'member', 1).feeAmount, '3800.00');
  assert.equal(perHectareFee('Rotavator', '2026-05-01', 'non_member', 1).feeAmount, '4000.00');
  assert.equal(perHectareFee('Squadrone', '2026-04-15', 'member', 1).feeAmount, '3500.00');
  assert.equal(perHectareFee('tudling', '2026-02-02', 'non_member', '0.25').feeAmount, '450.00');
});

test('no rate is found before a service type starts or for an unknown type', () => {
  assert.equal(findRateForDate(tractorRates, 'Squadrone', '2026-03-31'), null);
  assert.equal(findRateForDate(tractorRates, 'Rotavator', '2025-12-31'), null);
  assert.equal(findRateForDate(tractorRates, 'Plowing', '2026-06-01'), null);
});

test('harvest bag value can come from kg per bag x paddy price, and fractional bags round to centavos', () => {
  const fresh = computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: '57', kgPerBag: '50', pricePerKg: '14' });
  assert.equal(fresh.bagValue, '700.00');
  assert.equal(fresh.feeBags, '5.70');
  assert.equal(fresh.feeAmount, '3990.00');
  const dry = computeServiceFee({ unit: 'per_100_bags', rate: '12', totalBags: '33.5', kgPerBag: '45.5', pricePerKg: '24' });
  assert.equal(dry.feeBags, '4.02');
  assert.equal(dry.bagValue, '1092.00');
  assert.equal(dry.feeAmount, '4389.84');
});

test('area fees are exact for small fractions of a hectare', () => {
  assert.equal(computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '0.3333' }).feeAmount, '1266.54');
  assert.equal(computeServiceFee({ unit: 'per_ha', rate: '2800.50', areaHa: '0.1' }).feeAmount, '280.05');
});

test('per-day rates multiply by whole days', () => {
  assert.equal(computeServiceFee({ unit: 'per_day', rate: '600', days: 3 }).feeAmount, '1800.00');
  assert.throws(() => computeServiceFee({ unit: 'per_day', rate: '600', days: 1.5 }), FeeInputError);
});

test('invalid quantities are rejected with a clear message', () => {
  assert.throws(() => computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '0' }), /more than zero/);
  assert.throws(() => computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '-1' }), /zero or more/);
  assert.throws(() => computeServiceFee({ unit: 'per_ha', rate: '3800', areaHa: '1.23456' }), /4 decimal places/);
  assert.throws(() => computeServiceFee({ unit: 'per_100_bags', rate: '10', totalBags: '100' }), /value of one bag/);
  assert.throws(() => rateForClient(harvestRate, 'guest'), FeeInputError);
});

test('payment status follows the amounts like the database columns', () => {
  assert.deepEqual(paymentSummary('5700.00', '0'), { balance: '5700.00', paymentStatus: 'unpaid' });
  assert.deepEqual(paymentSummary('5700.00', '5700'), { balance: '0.00', paymentStatus: 'full' });
  assert.deepEqual(paymentSummary('0', '0'), { balance: '0.00', paymentStatus: 'full' });
});
