import { describe, test, expect } from '@jest/globals';
import { computePatronageRefund } from '../../src/services/patronage.js';

const peso = (amount) => Math.round(amount * 100);

describe('Patronage refund (computePatronageRefund)', () => {
  test('the worked example: 80 business and 90 participation points earn PHP 350 of PHP 35,000', () => {
    const result = computePatronageRefund({
      poolCents: peso(35000),
      memberBusiness: { machinery: peso(5000), loans: peso(3000) },
      memberAttended: { meeting: 8, community_development: 1, education_training: 1 },
      totalBusinessCents: peso(830000),
      totalParticipationPoints: 8300,
    });
    expect(result).toMatchObject({ weights: { business: 70, participation: 30 }, businessPool: peso(24500), participationPool: peso(10500), businessRefund: peso(236.14), participationRefund: peso(113.86), refund: peso(350) });
  });

  test('business and participation are each shared by their own points (70/30)', () => {
    const result = computePatronageRefund({ poolCents: peso(35000), memberBusiness: { machinery: peso(8000), loans: 0 }, memberAttended: { meeting: 9 }, totalBusinessCents: peso(400000), totalParticipationPoints: 4500 });
    expect(result).toMatchObject({ businessRefund: peso(490), participationRefund: peso(210), refund: peso(700) });
  });

  test('when nobody attended an activity, business takes the whole pool', () => {
    const result = computePatronageRefund({ poolCents: peso(1000), memberBusiness: { machinery: peso(100) }, memberAttended: {}, totalBusinessCents: peso(400), totalParticipationPoints: 0 });
    expect(result.weights).toEqual({ business: 100, participation: 0 });
    expect(result.refund).toBe(peso(250));
  });

  test('no pool, or no points at all, means no refund', () => {
    expect(computePatronageRefund({ poolCents: 0, memberBusiness: { loans: 100 }, memberAttended: { meeting: 1 }, totalBusinessCents: 100, totalParticipationPoints: 10 }).refund).toBe(0);
    expect(computePatronageRefund({ poolCents: peso(1000), totalBusinessCents: 0, totalParticipationPoints: 0 }).refund).toBe(0);
  });

  test('edge case: a loss year (negative pool) never gives a negative refund', () => {
    expect(computePatronageRefund({ poolCents: -5000, memberBusiness: { loans: 100 }, memberAttended: { meeting: 1 }, totalBusinessCents: 100, totalParticipationPoints: 10 }).refund).toBe(0);
  });
});
