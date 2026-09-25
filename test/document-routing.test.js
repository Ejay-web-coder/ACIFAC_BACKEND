// Unit tests for the parts of OCR document routing that need no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalysisPrompt, isPostable, normalizeAuthenticity, normalizeDocumentType, normalizeExtractedData, publicFormDefinitions, UNRECOGNIZED,
} from '../src/services/documentRouting.js';

test('document types: postable forms, legacy names and unknown values', () => {
  assert.equal(normalizeDocumentType('savings form'), 'Savings Form');
  assert.equal(normalizeDocumentType('Loan Application'), 'Loan Form');
  assert.equal(normalizeDocumentType('Grocery list'), UNRECOGNIZED);
  assert.equal(normalizeDocumentType(undefined), UNRECOGNIZED);
  for (const type of ['Membership Form', 'Loan Form', 'Savings Form', 'Machinery Form', 'Kadiwa Sales Form']) assert.ok(isPostable(type), type);
  assert.equal(isPostable('Payment Receipt'), false);
  assert.equal(publicFormDefinitions().length, 5);
});

test('extracted data is mapped onto the form keys and normalised', () => {
  const data = normalizeExtractedData('Savings Form', {
    'Member ID': 'ACIFAC-2026-001', member_name: 'Juan Dela Cruz', amount: '₱1,250.5', date: '01/20/2026', unexpected: 'dropped',
  });
  assert.equal(data.memberNumber, 'ACIFAC-2026-001');
  assert.equal(data.memberName, 'Juan Dela Cruz');
  assert.equal(data.amount, '1250.5');
  assert.equal(data.date, '2026-01-20');
  assert.equal(data.referenceNumber, '');
  assert.equal('unexpected' in data, false);

  const loan = normalizeExtractedData('Loan Form', { term: '12 months', farmArea: '1.5 ha', applicationDate: 'January 5, 2026' });
  assert.equal(loan.term, '12');
  assert.equal(loan.farmArea, '1.5');
  assert.equal(loan.applicationDate, '2026-01-05');

  // Unreadable values are kept as written so verification can point at them.
  assert.equal(normalizeExtractedData('Savings Form', { amount: 'five hundred' }).amount, 'five hundred');
  // Reference documents keep their own field names.
  assert.deepEqual(normalizeExtractedData('Payment Receipt', { 'Payment Amount': '500' }), { 'Payment Amount': '500' });
});

test('authenticity assessment is sanitised', () => {
  assert.deepEqual(normalizeAuthenticity({ score: '130', verdict: 'Genuine', physicalDocument: true, signaturePresent: 'yes', issues: ['a', 7] }), {
    score: 100, verdict: 'genuine', physicalDocument: true, filledIn: null, signaturePresent: null, issues: ['a', '7'],
  });
  assert.deepEqual(normalizeAuthenticity(null), { score: null, verdict: 'unknown', physicalDocument: null, filledIn: null, signaturePresent: null, issues: [] });
});

test('analysis prompt lists every form key and adapts to camera captures', () => {
  const prompt = buildAnalysisPrompt('upload');
  for (const key of ['memberNumber', 'encoderName', 'machinery', 'membershipDate', 'referenceNumber']) assert.ok(prompt.includes(key), key);
  assert.ok(prompt.includes('authenticity'));
  assert.ok(!prompt.includes('phone camera'));
  assert.ok(buildAnalysisPrompt('camera').includes('phone camera'));
});
