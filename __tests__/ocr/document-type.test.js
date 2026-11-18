import { describe, test, expect } from '@jest/globals';
import { isPostable, normalizeDocumentType, publicFormDefinitions, requiresIdDocument, UNRECOGNIZED } from '../../src/services/documentRouting.js';

describe('Scanned document type (normalizeDocumentType, isPostable)', () => {
  test('recognises the cooperative forms however the AI writes their names', () => {
    expect(normalizeDocumentType('membership form')).toBe('Membership Form');
    expect(normalizeDocumentType('Loan Application')).toBe('Loan Form');
    expect(normalizeDocumentType('Kadiwa Daily Sales Form')).toBe('Kadiwa Daily Sales Form');
  });

  test('anything that is not a known form is "not recognized"', () => {
    expect(normalizeDocumentType('Grocery list')).toBe(UNRECOGNIZED);
    expect(UNRECOGNIZED).toBe('Document Type Not Recognized');
  });

  test('a missing type is "not recognized"', () => {
    expect(normalizeDocumentType(undefined)).toBe(UNRECOGNIZED);
    expect(normalizeDocumentType('')).toBe(UNRECOGNIZED);
  });

  test('only the cooperative\'s forms can be saved to a module; receipts are kept for reference', () => {
    for (const type of ['Membership Form', 'Loan Form', 'Kadiwa Sales Form', 'Add Inventory Form', 'Kadiwa Daily Sales Form']) expect(isPostable(type)).toBe(true);
    expect(isPostable('Payment Receipt')).toBe(false);
    expect(isPostable(UNRECOGNIZED)).toBe(false);
    expect(publicFormDefinitions()).toHaveLength(7);
  });

  test('edge case: membership and loan forms need a valid ID; other forms do not', () => {
    expect(requiresIdDocument('Membership Form')).toBe(true);
    expect(requiresIdDocument('Loan Form')).toBe(true);
    expect(requiresIdDocument('Kadiwa Sales Form')).toBe(false);
  });
});
