import { query } from '../config/db.js';
import { TIME_ZONE } from '../config/env.js';
import { keepAlive } from '../utils/background.js';
import { normalizePhilippineMobile } from '../utils/phone.js';

// Text messages go out through textbee (textbee.dev): an Android phone with the
// cooperative's SIM runs the textbee app, and the API asks that phone to send.
// Configured only by environment variables; without them nothing is texted.
const apiUrl = (process.env.TEXTBEE_API_URL || 'https://api.textbee.dev/api/v1').replace(/\/$/, '');
const apiKey = process.env.TEXTBEE_API_KEY || '';
const deviceId = process.env.TEXTBEE_DEVICE_ID || '';

// Queued texts go out only between these hours (cooperative time zone, end
// exclusive), one at a time with a pause between them so the SIM is not
// flagged for bulk sending.
const [SEND_FROM_HOUR, SEND_UNTIL_HOUR] = parseHours(process.env.SMS_SEND_HOURS) || [7, 20];
const SEND_GAP_MS = Number(process.env.SMS_SEND_GAP_MS || 1500);
// A Vercel function has 60 seconds; whatever is left goes out on a later pass.
const PASS_BUDGET_MS = 30000;
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 10;
const EXPIRE_HOURS = 48;

function parseHours(value) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [from, until] = [Number(match[1]), Number(match[2])];
  return from < until && until <= 24 ? [from, until] : null;
}

export function isSmsConfigured() {
  return Boolean(apiKey && deviceId);
}

export function withinSendHours(now = new Date(), [from, until] = [SEND_FROM_HOUR, SEND_UNTIL_HOUR]) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return hour >= from && hour < until;
}

// textbee texts arrive from the SIM's plain mobile number, so every text is
// signed to show who sent it. Not needed once texts come from a provider with
// a registered "ACIFAC" sender ID.
export function signSms(message) {
  return `${message}\n- ACIFAC Administrator`;
}

// Resolves once textbee has accepted the text for the phone to send.
export async function sendSms(phone, message) {
  const response = await fetch(`${apiUrl}/gateway/devices/${encodeURIComponent(deviceId)}/send-sms`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipients: [phone], message: signSms(message) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`textbee answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
}

// Sends one text straight away, for messages someone is waiting on (password
// reset codes). Never throws. `phone` may be in any common Philippine format.
export async function sendSmsSafely(phone, message) {
  if (!isSmsConfigured()) return { sent: false, skipped: 'not_configured' };
  const to = normalizePhilippineMobile(phone);
  if (!to) return { sent: false, skipped: 'no_mobile_number' };
  try {
    await sendSms(to, message);
    return { sent: true };
  } catch (error) {
    console.error('SMS delivery error:', error instanceof Error ? error.message : error);
    return { sent: false, error };
  }
}

// Queues a text for each { user_id } row whose account has a mobile number
// and has not switched SMS off. The number is the member record's (kept up to
// date by the office), else the login account's. `template(row)` gives the text.
export async function queueSmsForUsers(rows, template) {
  if (!rows?.length || !isSmsConfigured()) return 0;
  const recipients = (await query(
    `SELECT u.id, COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS phone
     FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE u.id = ANY($1::int[]) AND COALESCE((u.notification_preferences ->> 'smsNotifications')::boolean, true)`,
    [[...new Set(rows.map((row) => Number(row.user_id)))]]
  )).rows;
  const phoneByUser = new Map(recipients.map((row) => [String(row.id), normalizePhilippineMobile(row.phone)]));
  const texts = rows
    .map((row) => ({ userId: Number(row.user_id), phone: phoneByUser.get(String(row.user_id)), message: template(row) }))
    .filter((text) => text.phone);
  if (!texts.length) return 0;
  await query(
    `INSERT INTO sms_outbox (user_id, phone, message) SELECT * FROM unnest($1::int[], $2::text[], $3::text[])`,
    [texts.map((text) => text.userId), texts.map((text) => text.phone), texts.map((text) => text.message)]
  );
  return texts.length;
}

let flushing = null;

// Sends queued texts, oldest first. Outside the sending hours it does nothing,
// so reminders created at midnight arrive in the morning. Stops at the first
// failure (the phone or textbee is unreachable) and at the pass budget. Server
// instances may flush at the same time: each text is claimed by pushing its
// retry_at forward under SKIP LOCKED, so no two instances send the same one.
// Never throws; resolves to the number of texts sent.
export function flushSmsOutbox() {
  if (!isSmsConfigured() || !withinSendHours()) return Promise.resolve(0);
  flushing ??= keepAlive(drainOutbox().finally(() => { flushing = null; }));
  return flushing;
}

async function drainOutbox() {
  const deadline = Date.now() + PASS_BUDGET_MS;
  let sent = 0;
  try {
    await query(`UPDATE sms_outbox SET status = 'expired' WHERE status = 'pending' AND created_at < NOW() - make_interval(hours => $1)`, [EXPIRE_HOURS]);
    while (Date.now() < deadline) {
      if (sent) await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
      const text = (await query(
        `UPDATE sms_outbox SET attempts = attempts + 1, retry_at = NOW() + make_interval(mins => $1)
         WHERE id = (SELECT id FROM sms_outbox WHERE status = 'pending' AND retry_at <= NOW() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING id, phone, message, attempts`,
        [RETRY_MINUTES]
      )).rows[0];
      if (!text) break;
      try {
        await sendSms(text.phone, text.message);
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        console.error('SMS delivery error:', reason);
        await query(
          `UPDATE sms_outbox SET last_error = $2, status = CASE WHEN attempts >= $3 THEN 'failed' ELSE status END WHERE id = $1`,
          [text.id, reason, MAX_ATTEMPTS]
        );
        break;
      }
      await query(`UPDATE sms_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = $1`, [text.id]);
      sent += 1;
    }
  } catch (error) {
    console.error('SMS outbox error:', error instanceof Error ? error.message : error);
  }
  return sent;
}

// ----- Texts ---------------------------------------------------------------
// Plain ASCII and, with the signature (signSms), at most 160 characters, so
// each is one SMS. A single character outside the GSM alphabet (such as ₱ or
// ñ) would cut the limit to 70.

export function passwordResetCodeSms({ code, expiresInMinutes = 10 }) {
  return `ACIFAC password reset code: ${code}. It expires in ${expiresInMinutes} minutes. Do not share it. If you did not ask for it, ignore this text.`;
}

// `message` is the notification text, e.g. "Installment 3 of loan L-2026-004
// (PHP 4,270.83) is due on October 2, 2026."
export function loanReminderSms({ message }) {
  return `${message} Please pay at the ACIFAC office.`;
}
