import { query } from '../config/db.js';
import { isEmailConfigured, sendEmail, sendEmailSafely } from './emailService.js';
import { keepAlive } from '../utils/background.js';

// Emails a member about activity on their record. The address is the one on
// their login account, falling back to their member record, so members without
// a login still hear about their savings, loans and rentals. The member's
// "Email notifications" setting is respected (see sendEmailSafely).
// `email` is a template result, or a function of the recipient ({ full_name })
// that returns one. Never throws; call it after the transaction has committed.
// includeTerminated: also when the membership is terminated (the email that
// tells the member so).
export function emailMember(memberId, email, { includeTerminated = false } = {}) {
  if (!memberId || !email) return Promise.resolve({ sent: false, skipped: true });
  // The address lookup also runs after the response, so all of it is kept alive.
  return keepAlive(sendToMember(memberId, email, includeTerminated));
}

async function sendToMember(memberId, email, includeTerminated) {
  try {
    const recipient = (await query(
      `SELECT u.id AS user_id, COALESCE(NULLIF(u.email, ''), m.email) AS email,
              TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS full_name
       FROM members m LEFT JOIN users u ON u.member_id = m.id AND u.account_status = 'ACTIVE'
       WHERE m.id = $1 AND ($2 OR m.status <> 'archived')
       ORDER BY u.id NULLS LAST LIMIT 1`,
      [memberId, includeTerminated]
    )).rows[0];
    if (!recipient?.email) return { sent: false, skipped: true };
    const content = typeof email === 'function' ? email(recipient) : email;
    return await sendEmailSafely({ ...content, to: recipient.email, relatedUserId: recipient.user_id });
  } catch (error) {
    console.error('Member email error:', error instanceof Error ? error.message : error);
    return { sent: false, error };
  }
}

// ----- One message to many members (announcements, activities) -------------

// Domains reserved for examples and tests (RFC 2606 and 6761) never receive
// mail. The sample members have them: sending to hundreds of them would only
// bring bounces and use up the mailbox's daily sending limit.
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
const ADDRESS = /^[^\s@,;<>"]+@([^\s@,;<>"]+\.[^\s@,;<>"]+)$/;

export function isDeliverableAddress(address) {
  const match = ADDRESS.exec(String(address ?? '').trim());
  return Boolean(match) && !RESERVED_DOMAIN.test(match[1]);
}

// Recipients per message, well under what mail providers such as Gmail accept in one message.
export const BULK_BATCH_SIZE = 50;

// The addresses for a message to many members: `memberIds`, or every active
// member when null. Each member's login account email, else their member
// record's (members without a login hear too); each address once; none for
// accounts that switched email notifications off, and none that cannot
// receive mail. Empty when email is not set up.
export async function bulkEmailRecipients(memberIds = null) {
  if (!isEmailConfigured() || (Array.isArray(memberIds) && !memberIds.length)) return [];
  const rows = (await query(
    `SELECT DISTINCT ON (lower(r.email)) r.email FROM (
       SELECT COALESCE(CASE WHEN u.account_status = 'ACTIVE' THEN NULLIF(TRIM(u.email), '') END, NULLIF(TRIM(m.email), '')) AS email,
              COALESCE((u.notification_preferences ->> 'emailNotifications')::boolean, true) AS allowed
       FROM members m
       LEFT JOIN LATERAL (
         SELECT email, account_status, notification_preferences FROM users WHERE member_id = m.id
         ORDER BY (account_status = 'ACTIVE') DESC, id LIMIT 1
       ) u ON TRUE
       WHERE m.status = 'active' AND ($1::int[] IS NULL OR m.id = ANY($1::int[]))
     ) r
     WHERE r.allowed AND r.email IS NOT NULL
     ORDER BY lower(r.email)`,
    [memberIds]
  )).rows;
  return rows.map((row) => row.email).filter(isDeliverableAddress);
}

// Sends the same email to every address, BULK_BATCH_SIZE at a time as BCC:
// nobody sees the others' addresses, and hundreds of members take a few
// messages instead of hundreds. A batch that fails does not stop the rest.
// Never throws; resolves to how many addresses it went to.
export function emailInBulk(addresses, email) {
  if (!addresses?.length || !email) return Promise.resolve(0);
  return keepAlive((async () => {
    let sent = 0;
    for (let start = 0; start < addresses.length; start += BULK_BATCH_SIZE) {
      const bcc = addresses.slice(start, start + BULK_BATCH_SIZE);
      try {
        const result = await sendEmail({ ...email, to: 'undisclosed-recipients:;', bcc });
        if (!result.sent) break;
        sent += bcc.length;
      } catch (error) {
        console.error('Bulk email error:', error instanceof Error ? error.message : error);
      }
    }
    return sent;
  })());
}

// Both of the above, after the response. Never throws.
export function emailMembersInBulk(memberIds, email) {
  return keepAlive((async () => {
    try {
      return await emailInBulk(await bulkEmailRecipients(memberIds), email);
    } catch (error) {
      console.error('Bulk email error:', error instanceof Error ? error.message : error);
      return 0;
    }
  })());
}

// Emails members about notifications that were just created for them (loan
// payment due / overdue). `rows` are { user_id, title, message }.
export async function emailNotifiedUsers(rows, template) {
  if (!rows?.length) return;
  const recipients = (await query(
    `SELECT u.id, COALESCE(NULLIF(u.email, ''), m.email) AS email
     FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = ANY($1::bigint[])`,
    [[...new Set(rows.map((row) => row.user_id))]]
  )).rows;
  const emailByUser = new Map(recipients.map((row) => [String(row.id), row.email]));
  await Promise.all(rows.map((row) => sendEmailSafely({ ...template(row), to: emailByUser.get(String(row.user_id)), relatedUserId: row.user_id })));
}
