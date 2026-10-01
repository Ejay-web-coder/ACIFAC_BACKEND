// Unit tests for the parts of OCR document routing that need no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalysisPrompt, buildIdPrompt, buildPhotoPrompt, isPostable, normalizeAuthenticity, normalizeDocumentType, normalizeExtractedData, normalizeIdReading,
  normalizePhotoReading, photoExpected, publicFormDefinitions, publicIdRequirements, requiresIdDocument, UNRECOGNIZED,
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
    score: 100, verdict: 'genuine', physicalDocument: true, filledIn: null, signaturePresent: null, photoRecognized: null, issues: ['a', '7'],
  });
  assert.deepEqual(normalizeAuthenticity(null), { score: null, verdict: 'unknown', physicalDocument: null, filledIn: null, signaturePresent: null, photoRecognized: null, issues: [] });
  assert.equal(normalizeAuthenticity({ photoRecognized: false }).photoRecognized, false);
});

test('analysis prompt lists every form key and adapts to camera captures', () => {
  const prompt = buildAnalysisPrompt('upload');
  for (const key of ['memberNumber', 'encoderName', 'machinery', 'membershipDate', 'referenceNumber']) assert.ok(prompt.includes(key), key);
  assert.ok(prompt.includes('authenticity'));
  assert.ok(!prompt.includes('phone camera'));
  assert.ok(buildAnalysisPrompt('camera').includes('phone camera'));
});

test('the membership form follows the paper form and needs the applicant ID', () => {
  const prompt = buildAnalysisPrompt('upload');
  for (const key of ['child3Name', 'income2Amount', 'motherLastName', 'bodResolution', 'membershipFeeOrNo', 'education', 'idNumber']) assert.ok(prompt.includes(key), key);
  assert.match(prompt, /system gives the membership number/);
  assert.ok(requiresIdDocument('Membership Form'));
  assert.equal(requiresIdDocument('Savings Form'), false);
  assert.deepEqual(publicFormDefinitions().filter((form) => form.requiresIdDocument).map((form) => form.type), ['Membership Form', 'Loan Form']);

  const data = normalizeExtractedData('Membership Form', { 'CP No.': '0917 123 4567', Birthday: '03/15/1990', child1Age: '7 ', income1Amount: '₱60,000' });
  assert.equal(data.phone, '0917 123 4567');
  assert.equal(data.dateOfBirth, '1990-03-15');
  assert.equal(data.child1Age, '7');
  assert.equal(data.income1Amount, '60000');
  assert.equal(data.email, '');
});

test('the ID reading is sanitised and the prompt fits how the ID was submitted', () => {
  assert.deepEqual(normalizeIdReading({
    isId: true, idType: 'PhilSys National ID', idNumber: 1234, name: ' Rosa Magsaysay ', dateOfBirth: '03/15/1990', frontVisible: true, backVisible: 'yes',
    signatureCount: '3', expired: null, issues: ['glare', 5],
  }), {
    isId: true, idType: 'PhilSys National ID', idNumber: '1234', name: 'Rosa Magsaysay', dateOfBirth: '1990-03-15', address: '', frontVisible: true, backVisible: null,
    photocopy: null, physicalCard: null, screen: null, signatureCount: 3, expired: null, issues: ['glare', '5'],
  });
  assert.equal(normalizeIdReading({ signatureCount: 'three' }).signatureCount, null);
  assert.equal(normalizeIdReading({ signatureCount: '' }).signatureCount, null);
  assert.equal(normalizeIdReading({ signatureCount: -1 }).signatureCount, null);
  assert.equal(normalizeIdReading({ dateOfBirth: 'unreadable' }).dateOfBirth, '');
  assert.equal(normalizeIdReading(null).isId, null);

  assert.match(buildIdPrompt('upload'), /back-to-back copy/);
  assert.match(buildIdPrompt('upload'), /3 specimen signatures/);
  assert.match(buildIdPrompt('camera'), /live camera/);
  assert.doesNotMatch(buildIdPrompt('camera'), /back-to-back copy/);
  assert.equal(normalizeIdReading({ address: ' Purok 1, Amnay ' }).address, 'Purok 1, Amnay');
});

test('a scanned loan form needs the borrower and co-maker IDs, each with 3 specimen signatures', () => {
  assert.ok(requiresIdDocument('Loan Form'));
  assert.deepEqual(publicIdRequirements('Loan Form'), [
    { slot: 'holder', person: 'borrower', label: 'Borrower\'s valid ID', cardCapture: false },
    { slot: 'coMaker', person: 'co-maker', label: 'Co-maker\'s valid ID', cardCapture: false },
  ]);
  assert.deepEqual(publicIdRequirements('Membership Form').map((requirement) => requirement.cardCapture), [true]);
  assert.deepEqual(publicIdRequirements('Savings Form'), []);
  const loanForm = publicFormDefinitions().find((form) => form.type === 'Loan Form');
  assert.equal(loanForm.fields.find((field) => field.key === 'coMakerName').required, true);

  const borrower = buildIdPrompt('upload', 'Loan Form', 'holder');
  assert.match(borrower, /the borrower submits with an ACIFAC cooperative loan application form/);
  assert.match(borrower, /borrower's 3 specimen signatures/);
  assert.match(borrower, /address/);
  // A loan ID taken with the camera is still the signed copy, never the bare card.
  const coMaker = buildIdPrompt('camera', 'Loan Form', 'coMaker');
  assert.match(coMaker, /the co-maker submits/);
  assert.match(coMaker, /co-maker's 3 specimen signatures/);
  assert.match(coMaker, /phone camera/);
  assert.doesNotMatch(coMaker, /signatureCount 0/);
});

test('the membership form 2x2 picture is checked on the form, or uploaded and checked', () => {
  assert.ok(photoExpected('Membership Form'));
  assert.equal(photoExpected('Loan Form'), false);
  assert.match(buildAnalysisPrompt('upload'), /photoRecognized/);
  assert.match(buildPhotoPrompt(), /faceVisible/);
  assert.deepEqual(normalizePhotoReading({ portrait: true, faceVisible: 'yes', screen: false, issues: ['dark'] }), { portrait: true, faceVisible: null, screen: false, issues: ['dark'] });
  assert.deepEqual(normalizePhotoReading(null), { portrait: null, faceVisible: null, screen: null, issues: [] });
});
