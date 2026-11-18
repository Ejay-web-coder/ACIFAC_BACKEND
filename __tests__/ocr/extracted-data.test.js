import { describe, test, expect } from '@jest/globals';
import { normalizeExtractedData, normalizePhone } from '../../src/services/documentRouting.js';

describe('Fields read from a scanned form (normalizeExtractedData, normalizePhone)', () => {
  test('maps the AI\'s labels onto the form fields and cleans the values', () => {
    const data = normalizeExtractedData('Savings Form', { 'Member ID': 'ACIFAC-2026-001', member_name: 'Juan Dela Cruz', amount: '₱1,250.5', date: '01/20/2026' });
    expect(data).toMatchObject({ memberNumber: 'ACIFAC-2026-001', memberName: 'Juan Dela Cruz', amount: '1250.5', date: '2026-01-20', referenceNumber: '' });
  });

  test('loan terms, farm areas and written dates are read as numbers and ISO dates', () => {
    expect(normalizeExtractedData('Loan Form', { term: '12 months', farmArea: '1.5 ha', applicationDate: 'January 5, 2026' }))
      .toMatchObject({ term: '12', farmArea: '1.5', applicationDate: '2026-01-05' });
  });

  test('unreadable values are kept as written so the reviewer can see them; unknown fields are dropped', () => {
    const data = normalizeExtractedData('Savings Form', { amount: 'five hundred', unexpected: 'dropped' });
    expect(data.amount).toBe('five hundred');
    expect(data).not.toHaveProperty('unexpected');
  });

  test('mobile numbers written any way become 09XXXXXXXXX; other text is left alone', () => {
    for (const written of ['0917 123 4567', '+63 917 123 4567', '63-917-123-4567', '9171234567']) expect(normalizePhone(written)).toBe('09171234567');
    expect(normalizePhone('(043) 288-1234')).toBe('(043) 288-1234');
    expect(normalizePhone('none')).toBe('none');
  });

  test('RSBSA numbers are written with dashes', () => {
    expect(normalizeExtractedData('Membership Form', { rsbsaNo: '17 51 08 012 000123', phone: '+639181234567' })).toMatchObject({ rsbsaNo: '17-51-08-012-000123', phone: '09181234567' });
  });

  test('edge case: reference documents keep their own field names', () => {
    expect(normalizeExtractedData('Payment Receipt', { 'Payment Amount': '500' })).toEqual({ 'Payment Amount': '500' });
  });
});
