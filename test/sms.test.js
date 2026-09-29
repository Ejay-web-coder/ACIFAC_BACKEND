import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPhilippineMobile, normalizePhilippineMobile } from '../src/utils/phone.js';

// Blank (not delete): src/config/env.js loads .env with dotenv, which only
// fills variables that are unset. Nothing here may reach the real database or gateway.
Object.assign(process.env, { ACIFAC_TIME_ZONE: 'Asia/Manila', SUPABASE_DB_URL: '', DATABASE_URL: '', TEXTBEE_API_KEY: '', TEXTBEE_DEVICE_ID: '' });
const { isSmsConfigured, loanReminderSms, passwordResetCodeSms, signSms, withinSendHours } = await import('../src/services/smsService.js');

test('Philippine mobile numbers are normalized to +639XXXXXXXXX', () => {
  for (const input of ['09171234567', '0917 123 4567', '0917-123-4567', '(0917) 123-4567', '639171234567', '+639171234567', '+63 917 123 4567', '9171234567', ' 09171234567 ']) {
    assert.equal(normalizePhilippineMobile(input), '+639171234567', input);
  }
  for (const input of ['', null, undefined, '(02) 8123 4567', '0281234567', '08171234567', '0917123456', '091712345678', '09171234567 / 09181234567', '+1 415 555 0100']) {
    assert.equal(normalizePhilippineMobile(input), null, String(input));
  }
});

test('a mobile number is shown with its middle digits hidden', () => {
  assert.equal(maskPhilippineMobile('+63 917 123 4567'), '0917 ••• 4567');
  assert.equal(maskPhilippineMobile('0918-555-0902'), '0918 ••• 0902');
  assert.equal(maskPhilippineMobile('(02) 8123 4567'), null);
});

test('texts fit in one SMS with the signature: plain GSM characters, at most 160', () => {
  const longest = loanReminderSms({ message: 'Installment 12 of loan L-2026-104 (PHP 999,999.99) was due on September 30, 2026 and is now overdue.' });
  for (const text of [passwordResetCodeSms({ code: '123456', expiresInMinutes: 10 }), longest].map(signSms)) {
    assert.ok(text.length <= 160, `${text.length}: ${text}`);
    assert.match(text, /^[A-Za-z0-9 .,:()'\n-]+$/);
    assert.ok(text.endsWith('\n- ACIFAC Administrator'), text);
  }
  assert.match(passwordResetCodeSms({ code: '042917' }), /code: 042917\./);
});

test('queued texts go out only during the day in Manila', () => {
  const hours = [7, 20];
  assert.equal(withinSendHours(new Date('2026-09-29T16:00:00Z'), hours), false, 'midnight (the old cron time)');
  assert.equal(withinSendHours(new Date('2026-09-29T22:59:00Z'), hours), false, '06:59');
  assert.equal(withinSendHours(new Date('2026-09-29T23:00:00Z'), hours), true, '07:00');
  assert.equal(withinSendHours(new Date('2026-09-30T00:00:00Z'), hours), true, '08:00 (the cron time)');
  assert.equal(withinSendHours(new Date('2026-09-30T11:59:00Z'), hours), true, '19:59');
  assert.equal(withinSendHours(new Date('2026-09-30T12:00:00Z'), hours), false, '20:00');
});

test('without a textbee API key and device ID nothing is texted', async () => {
  const { sendSmsSafely, queueSmsForUsers, flushSmsOutbox } = await import('../src/services/smsService.js');
  assert.equal(isSmsConfigured(), false);
  assert.deepEqual(await sendSmsSafely('09171234567', 'x'), { sent: false, skipped: 'not_configured' });
  assert.equal(await queueSmsForUsers([{ user_id: 1 }], () => 'x'), 0);
  assert.equal(await flushSmsOutbox(), 0);
});
