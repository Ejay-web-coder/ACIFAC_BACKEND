import { describe, test, expect } from '@jest/globals';
import { ACTIVITY_POINTS, businessPoints, participationPoints, PESOS_PER_BUSINESS_POINT } from '../../src/services/patronage.js';

const peso = (amount) => Math.round(amount * 100);

describe('Patronage points (businessPoints, participationPoints)', () => {
  test('one business point for every PHP 100 of business with the cooperative', () => {
    expect(PESOS_PER_BUSINESS_POINT).toBe(100);
    expect(businessPoints(peso(8000))).toBe(80);
    expect(businessPoints(peso(250))).toBe(2.5);
  });

  test('10 points per meeting attended, 5 per other activity', () => {
    expect(ACTIVITY_POINTS).toMatchObject({ meeting: 10, community_development: 5, education_training: 5 });
    expect(participationPoints({ meeting: 8, community_development: 1, education_training: 1 })).toBe(90);
  });

  test('no business and no attendance means no points', () => {
    expect(businessPoints(0)).toBe(0);
    expect(participationPoints({})).toBe(0);
  });

  test('edge case: activities of an unknown kind earn no points', () => {
    expect(participationPoints({ meeting: 2, fiesta: 5 })).toBe(20);
  });
});
