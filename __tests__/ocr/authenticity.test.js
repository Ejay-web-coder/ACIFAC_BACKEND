import { describe, test, expect } from '@jest/globals';
import { checksScore, normalizeAuthenticity } from '../../src/services/documentRouting.js';

describe('Authenticity and confidence of a scan (normalizeAuthenticity, checksScore)', () => {
  test('the AI\'s authenticity answer is cleaned and its score kept within 0 to 100', () => {
    expect(normalizeAuthenticity({ score: '130', verdict: 'Genuine', physicalDocument: true, signaturePresent: 'yes', issues: ['a', 7] })).toEqual({
      score: 100, verdict: 'genuine', physicalDocument: true, filledIn: null, signaturePresent: null, photoRecognized: null, issues: ['a', '7'],
    });
  });

  test('a recognised "no" is kept, not lost', () => {
    expect(normalizeAuthenticity({ photoRecognized: false }).photoRecognized).toBe(false);
  });

  test('a missing answer gives an "unknown" assessment', () => {
    expect(normalizeAuthenticity(null)).toEqual({ score: null, verdict: 'unknown', physicalDocument: null, filledIn: null, signaturePresent: null, photoRecognized: null, issues: [] });
  });

  test('confidence is the share of verification checks that passed', () => {
    expect(checksScore([{ status: 'pass' }, { status: 'pass' }, { status: 'warn' }, { status: 'fail' }])).toBe(50);
    expect(checksScore([{ status: 'pass' }])).toBe(100);
  });

  test('edge case: with no checks there is no confidence score', () => {
    expect(checksScore([])).toBeNull();
  });
});
