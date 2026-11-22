import { query } from '../config/db.js';
import { SQL_TODAY } from '../config/env.js';
import { centsToString } from '../utils/money.js';
import { formatDateOnly } from '../utils/dates.js';
import { emailNotifiedUsers } from './memberEmails.js';
import { duesReminderEmail } from './emailTemplates.js';

// Dues under the Membership Policy (amounts in centavos). Each due keeps the
// amount it was charged, so a later change here never changes old dues.
//   "Magbayad ng 250 every meeting para sa share capital subscription at 50
//    pesos para sa savings."
//   "Ang hindi pagdalo ng pagpupulong ng walang valid reason ay may penalty na 250."
//   "Kung maglilipat ng pagiging kasapi, may 500 pesos transfer fee."
export const DUES = {
  share_capital: { label: 'Share capital', cents: 25000, meeting: true },
  savings: { label: 'Savings', cents: 5000, meeting: true },
  absence_fine: { label: 'Absence fine', cents: 25000, meeting: true },
  transfer_fee: { label: 'Transfer fee', cents: 50000, meeting: false },
};
export const DUE_KINDS = Object.keys(DUES);
// Dues are paid in cash only, at the office.
export const DUES_PAYMENT_METHOD = 'Cash';
// Unpaid dues are reminded once a month, from a week after the oldest is due.
export const REMINDER_AFTER_DAYS = 7;

const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

/** The dues of one member at one meeting: share capital and savings always, the fine when absent without a valid reason. */
export function meetingDueKinds(attendanceStatus) {
  return attendanceStatus === 'absent' ? ['share_capital', 'savings', 'absence_fine'] : ['share_capital', 'savings'];
}

/** A due's state from its row: paid, waived or unpaid. */
export const dueState = (row) => (row.payment_id ?? row.paymentId ? 'paid' : row.waived_at ?? row.waivedAt ? 'waived' : 'unpaid');

/** What the member is told about the dues added at a meeting ({ kind, cents } list). */
export function meetingDuesMessage(title, date, added) {
  const cents = (kind) => added.filter((due) => due.kind === kind).reduce((sum, due) => sum + due.cents, 0);
  const parts = [];
  if (cents('share_capital')) parts.push(`${pesos(cents('share_capital'))} share capital`);
  if (cents('savings')) parts.push(`${pesos(cents('savings'))} savings`);
  let text = `For "${title}" on ${formatDateOnly(date)}: ${parts.join(' and ')}`;
  if (cents('absence_fine')) text += `${parts.length ? ', and ' : ''}a ${pesos(cents('absence_fine'))} fine for missing it without a valid reason`;
  const total = added.reduce((sum, due) => sum + due.cents, 0);
  return `${text}. Total ${pesos(total)}. Please pay at the ACIFAC office.`;
}

// Adds the meeting's dues for every member on its final attendance list who
// does not have them yet (share capital and savings; the fine for those
// absent), and removes an unpaid fine from a member who is no longer absent
// after a correction. A fine already paid or waived is left as it is and
// reported. Safe to run again. Members are notified of what changed.
// Returns { members, added, removedFines, keptFines }.
export async function syncMeetingDues(client, activityId, userId, { first = false } = {}) {
  const activity = (await client.query(`SELECT id, title, activity_date, category FROM activities WHERE id = $1`, [activityId])).rows[0];
  if (!activity || activity.category !== 'meeting') return { members: 0, added: 0, removedFines: 0, keptFines: 0 };
  const kinds = Object.entries(DUES).filter(([, due]) => due.meeting);
  const added = (await client.query(
    `INSERT INTO member_dues (member_id, kind, amount, due_date, activity_id, description, created_by)
     SELECT r.member_id, k.kind, k.amount, $2::date, $1, k.label || ': ' || $3, $4
     FROM activity_attendance r
     JOIN members m ON m.id = r.member_id AND m.status <> 'archived'
     CROSS JOIN unnest($5::text[], $6::numeric[], $7::text[]) AS k(kind, amount, label)
     WHERE r.activity_id = $1 AND (k.kind <> 'absence_fine' OR r.attendance_status = 'absent')
     ON CONFLICT (activity_id, member_id, kind) WHERE activity_id IS NOT NULL DO NOTHING
     RETURNING member_id, kind, amount`,
    [activity.id, activity.activity_date, activity.title, userId, kinds.map(([kind]) => kind), kinds.map(([, due]) => centsToString(due.cents)), kinds.map(([, due]) => due.label)]
  )).rows;
  const removed = (await client.query(
    `DELETE FROM member_dues d USING activity_attendance r
     WHERE d.activity_id = $1 AND d.kind = 'absence_fine' AND d.payment_id IS NULL AND d.waived_at IS NULL
       AND r.activity_id = d.activity_id AND r.member_id = d.member_id AND r.attendance_status <> 'absent'
     RETURNING d.member_id, d.amount`,
    [activity.id]
  )).rows;
  const kept = (await client.query(
    `SELECT COUNT(*)::int AS count FROM member_dues d JOIN activity_attendance r ON r.activity_id = d.activity_id AND r.member_id = d.member_id
     WHERE d.activity_id = $1 AND d.kind = 'absence_fine' AND (d.payment_id IS NOT NULL OR d.waived_at IS NOT NULL) AND r.attendance_status <> 'absent'`,
    [activity.id]
  )).rows[0].count;
  await client.query('UPDATE activities SET dues_charged_at = COALESCE(dues_charged_at, NOW()) WHERE id = $1', [activity.id]);

  // One notification per member: the dues added, or the fine taken off.
  const byMember = new Map();
  for (const row of added) {
    const entry = byMember.get(Number(row.member_id)) || { added: [], removed: 0 };
    entry.added.push({ kind: row.kind, cents: Math.round(Number(row.amount) * 100) });
    byMember.set(Number(row.member_id), entry);
  }
  for (const row of removed) {
    const entry = byMember.get(Number(row.member_id)) || { added: [], removed: 0 };
    entry.removed += Math.round(Number(row.amount) * 100);
    byMember.set(Number(row.member_id), entry);
  }
  const notes = [...byMember.entries()].map(([memberId, entry]) => {
    if (entry.added.length) {
      const fineOnly = entry.added.every((due) => due.kind === 'absence_fine');
      return {
        memberId,
        title: fineOnly ? `Absence fine: ${activity.title}` : `Meeting dues: ${activity.title}`,
        message: fineOnly
          ? `Your attendance at "${activity.title}" on ${formatDateOnly(activity.activity_date)} was corrected to absent without a valid reason, so a ${pesos(entry.added[0].cents)} fine was added. Please pay at the ACIFAC office.`
          : meetingDuesMessage(activity.title, activity.activity_date, entry.added),
        severity: entry.added.some((due) => due.kind === 'absence_fine') ? 'warning' : 'info',
        key: `dues-meeting-${activity.id}-${first ? 'charged' : `${Date.now()}`}`,
      };
    }
    return {
      memberId,
      title: `Absence fine removed: ${activity.title}`,
      message: `Your attendance at "${activity.title}" on ${formatDateOnly(activity.activity_date)} was corrected, so the ${pesos(entry.removed)} absence fine was taken off.`,
      severity: 'success',
      key: `dues-fine-removed-${activity.id}-${Date.now()}`,
    };
  });
  if (notes.length) {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
       SELECT u.id, 'dues_charged', LEFT(x.title, 200), x.message, x.severity, '/member/dues', 'activity', $1::text, x.key || '-' || u.id
       FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(member_id, title, message, severity, key)
       JOIN users u ON u.member_id = x.member_id AND u.account_status = 'ACTIVE'
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [activity.id, notes.map((n) => n.memberId), notes.map((n) => n.title), notes.map((n) => n.message), notes.map((n) => n.severity), notes.map((n) => n.key)]
    );
  }
  return { members: new Set(added.map((row) => Number(row.member_id))).size, added: added.length, removedFines: removed.length, keptFines: kept };
}

// Once a month, each member with dues unpaid for at least a week is reminded
// (notification, phone and email). Runs from the hourly timer and the daily cron.
export async function refreshDuesReminders() {
  try {
    const reminded = (await query(
      `WITH due AS (
         SELECT d.member_id, COUNT(*)::int AS count, SUM(d.amount) AS total, MIN(d.due_date) AS oldest
         FROM member_dues d JOIN members m ON m.id = d.member_id AND m.status <> 'archived'
         WHERE d.payment_id IS NULL AND d.waived_at IS NULL
         GROUP BY d.member_id
         HAVING MIN(d.due_date) <= ${SQL_TODAY} - $1::int
       ), sent AS (
         INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
         SELECT u.id, 'dues_reminder', 'Unpaid dues',
                format('You have %s unpaid %s totalling PHP %s, the oldest from %s. Please pay at the ACIFAC office.',
                       due.count, CASE WHEN due.count = 1 THEN 'due' ELSE 'dues' END, to_char(due.total, 'FM999,999,990.00'), to_char(due.oldest, 'FMMonth DD, YYYY')),
                'warning', '/member/dues', 'member', due.member_id::text, 'dues-reminder-' || to_char(${SQL_TODAY}, 'YYYY-MM')
         FROM due JOIN users u ON u.member_id = due.member_id AND u.account_status = 'ACTIVE'
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING user_id, entity_id
       )
       SELECT sent.user_id, due.count, due.total, due.oldest,
              TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS member_name
       FROM sent JOIN due ON due.member_id::text = sent.entity_id JOIN members m ON m.id = due.member_id`,
      [REMINDER_AFTER_DAYS]
    )).rows;
    if (reminded.length) {
      await emailNotifiedUsers(reminded, (row) => duesReminderEmail({ memberName: row.member_name, total: row.total, count: row.count, oldest: row.oldest }));
    }
    return reminded.length;
  } catch (error) {
    console.error('Dues reminders failed:', error instanceof Error ? error.message : error);
    return 0;
  }
}
