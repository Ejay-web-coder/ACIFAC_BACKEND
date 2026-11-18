import { describe, test, expect } from '@jest/globals';
import { isSmsConfigured, loanReminderSms, passwordResetCodeSms, sendSmsSafely, signSms, withinSendHours } from '../../src/services/smsService.js';

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
