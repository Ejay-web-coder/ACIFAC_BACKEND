import { query } from '../config/db.js';
import { TIME_ZONE } from '../config/env.js';
import { keepAlive } from '../utils/background.js';
import { normalizePhilippineMobile } from '../utils/phone.js';
import { formatDateOnly } from '../utils/dates.js';

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

// Queues a text for a member and sends it (now, or once the sending hours
// begin). The member's login account decides, by its "SMS notifications"
// setting; a member without a login is texted too, like the emails in
// memberEmails.js. The number is the member record's (kept up to date by the
// office), else the login account's. Terminated members are not texted.
// Never throws; call it after the transaction has committed. Resolves to
// whether a text was queued.
export function textMember(memberId, message) {
  if (!memberId || !message || !isSmsConfigured()) return Promise.resolve(false);
  return keepAlive((async () => {
    try {
      const row = (await query(
        `SELECT u.id AS user_id, COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS phone,
                COALESCE((u.notification_preferences ->> 'smsNotifications')::boolean, true) AS allowed
         FROM members m
         LEFT JOIN LATERAL (
           SELECT id, phone, notification_preferences FROM users WHERE member_id = m.id
           ORDER BY (account_status = 'ACTIVE') DESC, id LIMIT 1
         ) u ON TRUE
         WHERE m.id = $1 AND m.status <> 'archived'`,
        [memberId]
      )).rows[0];
      const phone = row?.allowed ? normalizePhilippineMobile(row.phone) : null;
      if (!phone) return false;
      await query(`INSERT INTO sms_outbox (user_id, phone, message) VALUES ($1, $2, $3)`, [row.user_id ?? null, phone, message]);
      await flushSmsOutbox();
      return true;
    } catch (error) {
      console.error('Member text error:', error instanceof Error ? error.message : error);
      return false;
    }
  })());
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

// What a text may hold before the signature: one SMS in all.
export const SMS_BODY_LIMIT = 160 - signSms('').length;

const pesos = (value) => `PHP ${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hasAmount = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
// "Sep 30, 2026" from "2026-09-30".
function shortDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
}
// Names typed into the system (machines) in plain ASCII: accents dropped and
// anything else outside it left out, so one character cannot turn the text
// into a 70-character SMS.
function plainText(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
}

// A loan application approved, or a loan the office recorded for the member.
// repayment 'single': the whole amount is due by dueDate (YYYY-MM-DD);
// otherwise monthly installments over `term` months.
export function loanApprovedSms({ amount, totalRepayment, dueDate, repayment = 'single', monthlyPayment, term }) {
  const approved = `ACIFAC: Your loan of ${pesos(amount)} was approved.`;
  if (!hasAmount(totalRepayment)) return approved;
  if (repayment !== 'single' && hasAmount(monthlyPayment) && term) {
    return `${approved} Total to pay: ${pesos(totalRepayment)}, ${pesos(monthlyPayment)} a month for ${term} months.`;
  }
  return `${approved} Total to pay: ${pesos(totalRepayment)}${dueDate ? ` by ${formatDateOnly(String(dueDate).slice(0, 10))}` : ''}.`;
}

const shorten = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`);
// text(part), with `part` shortened ("...") as much as it takes to stay one SMS.
const fitted = (text, part) => text(shorten(part, SMS_BODY_LIMIT - text('').length));
// A decline reason gets at least this much room; a long machine name gives way to it.
const REASON_ROOM = 40;
const MACHINE_NAME_MIN = 24;

const ASK_THE_OFFICE = 'Please ask the ACIFAC office for details.';
const withFullStop = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// A loan application declined, with the reason the office gave (shortened if
// long: the email and the notification in the app have all of it).
export function loanDeclinedSms({ amount, reason = '' }) {
  const declined = `ACIFAC: Your loan application for ${pesos(amount)} was declined.`;
  const why = plainText(reason);
  if (!why) return `${declined} ${ASK_THE_OFFICE}`;
  return fitted((part) => `${declined} Reason: ${part}`, withFullStop(why));
}

// "on Dec 3, 2026", "from Dec 3 to Dec 5, 2026", "from Dec 30, 2026 to Jan 2, 2027".
function rentalDays(startDate, endDate) {
  const start = String(startDate).slice(0, 10);
  const end = String(endDate).slice(0, 10);
  if (start === end) return `on ${shortDate(start)}`;
  if (start.slice(0, 4) === end.slice(0, 4)) return `from ${shortDate(start).replace(/, \d{4}$/, '')} to ${shortDate(end)}`;
  return `from ${shortDate(start)} to ${shortDate(end)}`;
}

// A member's machinery rental request approved (with the fee) or declined
// (with the office's reason). Long names and reasons are shortened so the
// text stays one SMS; the email and the notification in the app have all of it.
function rentalDecisionSms({ machineryName, startDate, endDate, rentalFee, reason = '' }, status) {
  const days = rentalDays(startDate, endDate);
  const name = plainText(machineryName) || 'the machine';
  const why = plainText(reason);
  if (status === 'declined' && why) {
    const text = (machine) => (part) => `ACIFAC: Your request to rent ${machine} ${days} was declined. Reason: ${part}`;
    const room = SMS_BODY_LIMIT - text(name)('').length;
    const machine = room >= REASON_ROOM ? name : shorten(name, Math.max(MACHINE_NAME_MIN, name.length - (REASON_ROOM - room)));
    return fitted(text(machine), withFullStop(why));
  }
  const after = status === 'approved'
    ? (hasAmount(rentalFee) && Number(rentalFee) > 0 ? ` Fee: ${pesos(rentalFee)}.` : '')
    : ' Ask the office for details.';
  return fitted((machine) => `ACIFAC: Your request to rent ${machine} ${days} was ${status}.${after}`, name);
}

export const rentalApprovedSms = (rental) => rentalDecisionSms(rental, 'approved');
export const rentalDeclinedSms = (rental) => rentalDecisionSms(rental, 'declined');
