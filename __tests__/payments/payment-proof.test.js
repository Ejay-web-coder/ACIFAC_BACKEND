import { describe, test, expect } from '@jest/globals';
import {
  normalizeProofReading, normalizeReference, OLD_PAYMENT_DAYS, proofFlags, recipientMatches,
} from '../../src/services/paymentProof.js';

// Pay online: what AI read on a GCash or Maya screenshot, compared with what
// the member typed and with the cooperative's account.

const ACCOUNT = { accountNumber: '09171234567', accountName: 'ACIFAC' };
const SUBMISSION = { amountCents: 150000, referenceNumber: '1009876543210', paidOn: '2026-11-20', channel: 'GCash' };
const GOOD_READING = normalizeProofReading({
  isPaymentReceipt: true, app: 'GCash', status: 'successful', amount: '1,500.00', referenceNumber: '1009 876 543210',
  date: '2026-11-20', time: '14:05', recipientName: 'AC****C', recipientNumber: '+63 917 *** 4567', confidence: 93,
});
const codes = (flags) => flags.map((flag) => flag.code);
const flagsFor = (changes = {}, reading = GOOD_READING, extra = {}) => proofFlags({ reading: { ...reading, ...changes }, submission: SUBMISSION, account: ACCOUNT, today: '2026-11-22', ...extra });

describe('Reading a payment screenshot (normalizeProofReading)', () => {
  test('the amount loses its sign and commas, the reference number its spaces; unknown answers are empty', () => {
    expect(GOOD_READING).toMatchObject({ isPaymentReceipt: true, app: 'GCash', status: 'successful', amount: '1500.00', referenceNumber: '1009876543210', date: '2026-11-20', confidence: 93 });
    expect(normalizeProofReading({ amount: '₱ 250', app: 'gcash', status: 'SUCCESSFUL' })).toMatchObject({ amount: '250.00', app: 'GCash', status: 'successful' });
  });

  test('edge case: nonsense or a missing answer reads as nothing, never as a value', () => {
    expect(normalizeProofReading(null)).toMatchObject({ isPaymentReceipt: false, app: 'unknown', status: 'unknown', amount: '', referenceNumber: '', date: '' });
    expect(normalizeProofReading({ amount: 'one thousand', date: '2026-02-30', confidence: 400, isPaymentReceipt: 'yes' }))
      .toMatchObject({ amount: '', date: '', confidence: 100, isPaymentReceipt: false });
  });

  test('reference numbers are compared without spaces, dashes or case', () => {
    expect(normalizeReference(' ab-12 34 cd ')).toBe('AB1234CD');
  });
});

describe('The number the money went to (recipientMatches)', () => {
  test('a partly hidden number matches on the digits it shows', () => {
    expect(recipientMatches('+63 917 *** 4567', '09171234567')).toBe(true);
    expect(recipientMatches('0917 ••• 4567', '09171234567')).toBe(true);
    expect(recipientMatches('0917-123-4567', '09171234567')).toBe(true);
  });

  test('another number does not match', () => {
    expect(recipientMatches('+63 918 *** 4567', '09171234567')).toBe(false);
    expect(recipientMatches('09991112222', '09171234567')).toBe(false);
  });

  test('edge case: too little shown to tell, or no account number, is "cannot tell"', () => {
    expect(recipientMatches('**** 67', '09171234567')).toBeNull();
    expect(recipientMatches('', '09171234567')).toBeNull();
    expect(recipientMatches('09171234567', '')).toBeNull();
  });
});

describe('What the office is warned about (proofFlags)', () => {
  test('a screenshot that agrees with everything has no flags', () => {
    expect(flagsFor()).toEqual([]);
  });

  test('another amount, another reference number or another recipient are errors', () => {
    expect(codes(flagsFor({ amount: '150.00' }))).toEqual(['amount_mismatch']);
    expect(codes(flagsFor({ referenceNumber: '1009876543219' }))).toEqual(['reference_mismatch']);
    const wrong = flagsFor({ recipientNumber: '0999 *** 0000' });
    expect(codes(wrong)).toEqual(['wrong_recipient']);
    expect(wrong[0].message).toContain('09171234567');
  });

  test('not a payment, or a payment that failed, is an error; another app is a warning', () => {
    expect(codes(flagsFor({ isPaymentReceipt: false }))).toEqual(['not_receipt']);
    expect(codes(flagsFor({ status: 'failed' }))).toEqual(['not_successful']);
    expect(codes(flagsFor({ app: 'Maya' }))).toEqual(['app_mismatch']);
  });

  test(`an old payment (more than ${OLD_PAYMENT_DAYS} days) and another date are warnings`, () => {
    const old = proofFlags({ reading: { ...GOOD_READING, date: '2026-11-01' }, submission: { ...SUBMISSION, paidOn: '2026-11-01' }, account: ACCOUNT, today: '2026-11-22' });
    expect(codes(old)).toEqual(['old_payment']);
    expect(codes(flagsFor({ date: '2026-11-19' }))).toEqual(['date_mismatch']);
    // Exactly the limit is not old yet.
    const limit = proofFlags({ reading: { ...GOOD_READING, date: '2026-11-15' }, submission: { ...SUBMISSION, paidOn: '2026-11-15' }, account: ACCOUNT, today: '2026-11-22' });
    expect(codes(limit)).toEqual([]);
  });

  test('the same screenshot or a reference already on the records is an error, listed first', () => {
    const flags = flagsFor({ date: '2026-11-19' }, GOOD_READING, { sameScreenshot: [{ id: 7, status: 'approved' }], referenceRecorded: ['a dues payment'] });
    expect(codes(flags)).toEqual(['same_screenshot', 'reference_recorded', 'date_mismatch']);
    expect(flags[1].message).toBe('Reference number 1009876543210 is already on a dues payment.');
  });

  test('edge case: AI could not read it: one warning, and the date the member gave is still checked', () => {
    const flags = proofFlags({ reading: { error: 'The AI service is busy right now.' }, submission: { ...SUBMISSION, paidOn: '2026-10-01' }, account: ACCOUNT, today: '2026-11-22' });
    expect(codes(flags)).toEqual(['not_read', 'old_payment']);
    expect(flags[0].message).toContain('busy');
  });

  test('values AI could not read are warnings, not errors', () => {
    const flags = flagsFor({ amount: '', referenceNumber: '', recipientNumber: '' });
    expect(codes(flags)).toEqual(['amount_unread', 'reference_unread', 'recipient_unread']);
    expect(flags.every((flag) => flag.severity === 'warning')).toBe(true);
  });
});
