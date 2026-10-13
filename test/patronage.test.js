// Unit tests for the patronage refund point system (no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { businessPoints, computePatronageRefund, participationPoints } from '../src/services/patronage.js';

const peso = (amount) => Math.round(amount * 100);

test('points: 1 per PHP 100 of business; 10 per meeting, 5 per other activity attended', () => {
  assert.equal(businessPoints(peso(8000)), 80);
  assert.equal(businessPoints(peso(250)), 2.5);
  assert.equal(participationPoints({ meeting: 8, community_development: 1, education_training: 1 }), 90);
  assert.equal(participationPoints({}), 0);
  assert.equal(participationPoints({ meeting: 2, unknown: 5 }), 20, 'other categories earn no points');
});

test('the worked example: PHP 35,000 pool, 80 business and 90 participation points of 8,300 each', () => {
  // With equal totals the two parts reduce to the single score (80 x 0.70 + 90 x 0.30 = 83 of 8,300 = 1%).
  const result = computePatronageRefund({
    poolCents: peso(35000),
    memberBusiness: { machinery: peso(5000), loans: peso(3000) },
    memberAttended: { meeting: 8, community_development: 1, education_training: 1 },
    totalBusinessCents: peso(830000),
    totalParticipationPoints: 8300,
  });
  assert.deepEqual(result.weights, { business: 70, participation: 30 });
  assert.equal(result.businessPool, peso(24500));
  assert.equal(result.participationPool, peso(10500));
  assert.equal(result.businessPoints, 80);
  assert.equal(result.participationPoints, 90);
  assert.equal(result.businessRefund, peso(236.14));
  assert.equal(result.participationRefund, peso(113.86));
  assert.equal(result.refund, peso(350));
  assert.ok(Math.abs(result.poolShare - 0.01) < 1e-12);
});

test('each part is shared by its own points, so the 70/30 split holds at any scale', () => {
  // PHP 8,000 of PHP 400,000 business (2%), 90 of 4,500 participation points (2%).
  const result = computePatronageRefund({
    poolCents: peso(35000),
    memberBusiness: { machinery: peso(8000), loans: 0 },
    memberAttended: { meeting: 9 },
    totalBusinessCents: peso(400000),
    totalParticipationPoints: 4500,
  });
  assert.equal(result.businessRefund, peso(490));
  assert.equal(result.participationRefund, peso(210));
  assert.equal(result.refund, peso(700));
  assert.equal(result.memberBusiness.total, peso(8000));
});

test('when no member has points of one kind, the other part takes the whole pool', () => {
  const noAttendance = computePatronageRefund({
    poolCents: peso(1000), memberBusiness: { machinery: peso(100) }, memberAttended: {}, totalBusinessCents: peso(400), totalParticipationPoints: 0,
  });
  assert.deepEqual(noAttendance.weights, { business: 100, participation: 0 });
  assert.equal(noAttendance.refund, peso(250));
  const noBusiness = computePatronageRefund({
    poolCents: peso(1000), memberBusiness: {}, memberAttended: { meeting: 1 }, totalBusinessCents: 0, totalParticipationPoints: 40,
  });
  assert.deepEqual(noBusiness.weights, { business: 0, participation: 100 });
  assert.equal(noBusiness.refund, peso(250));
  const nothing = computePatronageRefund({ poolCents: peso(1000), totalBusinessCents: 0, totalParticipationPoints: 0 });
  assert.deepEqual(nothing.weights, { business: 0, participation: 0 });
  assert.equal(nothing.refund, 0);
});

test('no pool means no refund; amounts are whole centavos and exact when large', () => {
  for (const poolCents of [0, -5000]) {
    const result = computePatronageRefund({ poolCents, memberBusiness: { loans: 100 }, memberAttended: { meeting: 1 }, totalBusinessCents: 100, totalParticipationPoints: 10 });
    assert.equal(result.refund, 0);
  }
  const big = computePatronageRefund({
    poolCents: 999_999_999_99, memberBusiness: { machinery: 123_456_789_01 }, memberAttended: { meeting: 3 }, totalBusinessCents: 987_654_321_09, totalParticipationPoints: 70,
  });
  assert.equal(big.businessPool + big.participationPool, 999_999_999_99);
  assert.ok(Number.isInteger(big.businessRefund) && Number.isInteger(big.participationRefund));
  assert.ok(big.refund <= big.businessPool + big.participationPool);
});
