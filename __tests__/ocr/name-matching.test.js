import { describe, test, expect } from '@jest/globals';
import { NAME_MATCH_MIN, nameSimilarity, placeKey, textSimilarity } from '../../src/services/documentRouting.js';

describe('Matching names and places read from forms (nameSimilarity, textSimilarity, placeKey)', () => {
  test('the same name in another order, or without the middle name, matches fully', () => {
    expect(nameSimilarity('Juan Dela Cruz', 'DELA CRUZ, JUAN')).toBe(1);
    expect(nameSimilarity('Juan Dela Cruz', 'Juan Santos Dela Cruz')).toBe(1);
  });

  test('a letter misread by the AI still matches (at least 90%)', () => {
    expect(NAME_MATCH_MIN).toBe(0.9);
    expect(nameSimilarity('Juan Dela Cruz', 'Juan Dela Crus')).toBeGreaterThanOrEqual(NAME_MATCH_MIN);
  });

  test('a different person does not match', () => {
    expect(nameSimilarity('Juan Dela Cruz', 'Pedro Penduko')).toBeLessThan(0.5);
    expect(nameSimilarity('Maria Santos', 'Marta Santos')).toBeLessThan(1);
  });

  test('blank names never match', () => {
    expect(nameSimilarity('', 'Juan Dela Cruz')).toBe(0);
    expect(textSimilarity('', 'abc')).toBe(0);
    expect(textSimilarity('abc', 'abc')).toBe(1);
  });

  test('place names compare loosely: Sta./Santa, Brgy./Barangay', () => {
    expect(placeKey('Sta. Cruz')).toBe(placeKey('Santa Cruz'));
    expect(placeKey('Brgy. Barahan')).toBe(placeKey('BARAHAN'));
  });

  test('edge case: very long texts are not compared', () => {
    expect(textSimilarity('a'.repeat(301), 'a'.repeat(300))).toBe(0);
  });
});
