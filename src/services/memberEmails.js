import { query } from '../config/db.js';
import { sendEmailSafely } from './emailService.js';
import { keepAlive } from '../utils/background.js';

// Emails a member about activity on their record. The address is the one on
// their login account, falling back to their member record, so members without
// a login still hear about their savings, loans and rentals. The member's
// "Email notifications" setting is respected (see sendEmailSafely).
// `email` is a template result, or a function of the recipient ({ full_name })
// that returns one. Never throws; call it after the transaction has committed.
export function emailMember(memberId, email) {
  if (!memberId || !email) return Promise.resolve({ sent: false, skipped: true });
  // The address lookup also runs after the response, so all of it is kept alive.
  return keepAlive(sendToMember(memberId, email));
}

async function sendToMember(memberId, email) {
  try {
    const recipient = (await query(
      `SELECT u.id AS user_id, COALESCE(NULLIF(u.email, ''), m.email) AS email,
              TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS full_name
       FROM members m LEFT JOIN users u ON u.member_id = m.id AND u.account_status = 'ACTIVE'
       WHERE m.id = $1 AND m.status <> 'archived'
       ORDER BY u.id NULLS LAST LIMIT 1`,
      [memberId]
    )).rows[0];
    if (!recipient?.email) return { sent: false, skipped: true };
    const content = typeof email === 'function' ? email(recipient) : email;
    return await sendEmailSafely({ ...content, to: recipient.email, relatedUserId: recipient.user_id });
  } catch (error) {
    console.error('Member email error:', error instanceof Error ? error.message : error);
    return { sent: false, error };
  }
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
