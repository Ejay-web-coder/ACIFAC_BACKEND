import { describe, test, expect } from '@jest/globals';
import { buildAnalysisPrompt, buildCrossCheckPrompt, compareReadings } from '../../src/services/documentRouting.js';

const first = { lastName: 'Dela Cruz', firstName: 'Juan', dateOfBirth: '1990-03-15', phone: '09171234567', farmAreaHa: '1.50' };

describe('Reading a form twice (compareReadings, buildAnalysisPrompt, buildCrossCheckPrompt)', () => {
  test('two readings that agree flag nothing, ignoring case and trailing zeros', () => {
    expect(compareReadings('Membership Form', first, { ...first, lastName: 'DELA CRUZ', farmAreaHa: '1.5' })).toMatchObject({ differing: [], compared: 5 });
  });

  test('the values the two readings disagree on are flagged', () => {
    expect(compareReadings('Membership Form', first, { ...first, dateOfBirth: '1990-03-16', phone: '' }).differing).toEqual(['dateOfBirth', 'phone']);
  });

  test('the first reading asks for every form field and an authenticity check', () => {
    const prompt = buildAnalysisPrompt('upload');
    for (const key of ['memberNumber', 'grandTotal', 'membershipDate', 'coMakerName', 'authenticity']) expect(prompt).toContain(key);
  });

  test('a phone camera capture is described as one; an upload is not', () => {
    expect(buildAnalysisPrompt('camera')).toContain('phone camera');
    expect(buildAnalysisPrompt('upload')).not.toContain('phone camera');
  });

  test('edge case: the second reading only copies the fields, like a data-entry clerk', () => {
    expect(buildCrossCheckPrompt()).toMatch(/data-entry clerk/);
    expect(buildCrossCheckPrompt()).not.toContain('authenticity');
  });
});
