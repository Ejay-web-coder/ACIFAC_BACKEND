import { describe, test, expect } from '@jest/globals';
import {
  isSmsConfigured, loanApprovedSms, loanDeclinedSms, loanReminderSms, passwordResetCodeSms, rentalApprovedSms, rentalDeclinedSms, sendSmsSafely, signSms, SMS_BODY_LIMIT, withinSendHours,
} from '../../src/services/smsService.js';

describe('Text message content and sending hours (signSms, withinSendHours)', () => {
  test('every text is signed by the ACIFAC Administrator', () => {
    expect(signSms('Hello')).toBe('Hello\n- ACIFAC Administrator');
  });

  test('the password reset and loan reminder texts fit one 160-character SMS', () => {
    const longest = loanReminderSms({ message: 'Installment 12 of loan L-2026-104 (PHP 999,999.99) was due on September 30, 2026 and is now overdue.' });
    for (const text of [passwordResetCodeSms({ code: '042917' }), longest].map(signSms)) {
      expect(text.length).toBeLessThanOrEqual(160);
      expect(text).toMatch(/^[A-Za-z0-9 .,:()'\n-]+$/);
    }
    expect(passwordResetCodeSms({ code: '042917' })).toContain('code: 042917.');
  });

  test('queued texts go out only from 7:00 AM to before 8:00 PM, Manila time', () => {
    expect(withinSendHours(new Date('2026-09-29T23:00:00Z'), [7, 20])).toBe(true);
    expect(withinSendHours(new Date('2026-09-30T11:59:00Z'), [7, 20])).toBe(true);
    expect(withinSendHours(new Date('2026-09-29T22:59:00Z'), [7, 20])).toBe(false);
    expect(withinSendHours(new Date('2026-09-30T12:00:00Z'), [7, 20])).toBe(false);
  });

  test('without the gateway key and device nothing is texted', async () => {
    expect(isSmsConfigured()).toBe(false);
    await expect(sendSmsSafely('09171234567', 'x')).resolves.toEqual({ sent: false, skipped: 'not_configured' });
  });

  test('edge case: midnight, when the daily check runs, is outside the sending hours', () => {
    expect(withinSendHours(new Date('2026-09-29T16:00:00Z'), [7, 20])).toBe(false);
  });
});

describe('Approval and decline texts (loanApprovedSms, loanDeclinedSms, rentalApprovedSms, rentalDeclinedSms)', () => {
  const oneSms = (text) => {
    expect(signSms(text).length).toBeLessThanOrEqual(160);
    expect(text).toMatch(/^[A-Za-z0-9 .,:()'-]+$/);
  };

  test('an approved loan says the amount, the total to pay and when it is due', () => {
    const text = loanApprovedSms({ amount: '50000.00', totalRepayment: '57500.00', dueDate: '2027-05-24', repayment: 'single' });
    expect(text).toBe('ACIFAC: Your loan of PHP 50,000.00 was approved. Total to pay: PHP 57,500.00 by May 24, 2027.');
    oneSms(text);
  });

  test('a loan paid monthly says the installment instead of a due date', () => {
    const text = loanApprovedSms({ amount: '999999.99', totalRepayment: '999999.99', monthlyPayment: '999999.99', term: 12, repayment: 'monthly' });
    expect(text).toBe('ACIFAC: Your loan of PHP 999,999.99 was approved. Total to pay: PHP 999,999.99, PHP 999,999.99 a month for 12 months.');
    oneSms(text);
  });

  test('an approved rental says the machine, the days and the fee', () => {
    expect(rentalApprovedSms({ machineryName: 'Water Pump', startDate: '2026-12-03', endDate: '2026-12-05', rentalFee: '2400.00' }))
      .toBe('ACIFAC: Your request to rent Water Pump from Dec 3 to Dec 5, 2026 was approved. Fee: PHP 2,400.00.');
    expect(rentalApprovedSms({ machineryName: 'Water Pump', startDate: '2026-12-30', endDate: '2027-01-02', rentalFee: '2400.00' }))
      .toBe('ACIFAC: Your request to rent Water Pump from Dec 30, 2026 to Jan 2, 2027 was approved. Fee: PHP 2,400.00.');
    expect(rentalApprovedSms({ machineryName: 'Water Pump', startDate: '2026-12-03', endDate: '2026-12-03', rentalFee: '0.00' }))
      .toBe('ACIFAC: Your request to rent Water Pump on Dec 3, 2026 was approved.');
  });

  test('a long or accented machine name is shortened to plain text so the rental text stays one SMS', () => {
    const text = rentalApprovedSms({ machineryName: 'Kubota DC-70 Plus Combine Harvester – Unit 2 (Amnay–Cabagan, Señor Lot)', startDate: '2026-09-30', endDate: '2026-12-31', rentalFee: '99999.99' });
    oneSms(text);
    // Uses the room there is (a space before the "..." is dropped).
    expect(signSms(text).length).toBeGreaterThanOrEqual(158);
    expect(text).toMatch(/^ACIFAC: Your request to rent Kubota DC-70 Plus Combine Harvester .*\.\.\. from Sep 30 to Dec 31, 2026 was approved\. Fee: PHP 99,999\.99\.$/);
  });

  test('a declined loan gives the reason the office wrote, or says to ask the office', () => {
    expect(loanDeclinedSms({ amount: '1000', reason: 'Incomplete documents' }))
      .toBe('ACIFAC: Your loan application for PHP 1,000.00 was declined. Reason: Incomplete documents.');
    expect(loanDeclinedSms({ amount: '1000', reason: 'Unpaid balance on loan L-2026-004.' })).toMatch(/Reason: Unpaid balance on loan L-2026-004\.$/);
    expect(loanDeclinedSms({ amount: '1000', reason: '' }))
      .toBe('ACIFAC: Your loan application for PHP 1,000.00 was declined. Please ask the ACIFAC office for details.');
    expect(loanDeclinedSms({ amount: '1000', reason: null })).toMatch(/Please ask the ACIFAC office for details\.$/);
  });

  test('a long declined-loan reason is shortened so the text stays one SMS', () => {
    const text = loanDeclinedSms({ amount: '999999.99', reason: 'The co-maker’s signature is missing, the farm area does not match the RSBSA record, and the ID is expired.\nPlease reapply.' });
    oneSms(text);
    expect(signSms(text)).toHaveLength(160);
    expect(text).toMatch(/^ACIFAC: Your loan application for PHP 999,999\.99 was declined\. Reason: The co-maker s signature is missing, .+\.\.\.$/);
  });

  test('a declined rental gives the office\'s reason', () => {
    expect(rentalDeclinedSms({ machineryName: 'Water Pump', startDate: '2026-12-03', endDate: '2026-12-05', rentalFee: '2400.00', reason: 'The pump is under repair that week' }))
      .toBe('ACIFAC: Your request to rent Water Pump from Dec 3 to Dec 5, 2026 was declined. Reason: The pump is under repair that week.');
  });

  test('a long machine name gives way to the reason, and both are shortened to stay one SMS', () => {
    const text = rentalDeclinedSms({
      machineryName: 'Kubota DC-70 Plus Combine Harvester Unit 2', startDate: '2026-12-30', endDate: '2027-01-02',
      reason: 'Another member booked the harvester first for those days, and the operator is on leave.',
    });
    oneSms(text);
    expect(signSms(text)).toHaveLength(160);
    expect(text).toMatch(/^ACIFAC: Your request to rent Kubota DC-70 Plus Com\.\.\. from Dec 30, 2026 to Jan 2, 2027 was declined\. Reason: Another member booked .+\.\.\.$/);
  });

  test('edge case: a decline without a reason (one from before reasons were asked) says to ask the office', () => {
    expect(rentalDeclinedSms({ machineryName: 'Water Pump', startDate: '2026-12-03', endDate: '2026-12-03', rentalFee: '2400.00' }))
      .toBe('ACIFAC: Your request to rent Water Pump on Dec 3, 2026 was declined. Ask the office for details.');
  });

  test('edge case: without the loan figures the text still says it was approved', () => {
    expect(loanApprovedSms({ amount: '5000', totalRepayment: null })).toBe('ACIFAC: Your loan of PHP 5,000.00 was approved.');
    expect(SMS_BODY_LIMIT).toBe(137);
  });
});
