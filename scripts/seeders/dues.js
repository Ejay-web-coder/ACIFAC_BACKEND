import { TIME_ZONE } from '../../src/config/env.js';
import { DUES, DUES_PAYMENT_METHOD, syncMeetingDues } from '../../src/services/dues.js';
import { centsToString } from '../../src/utils/money.js';
import { addDays, officeDayOnOrBefore } from './support.js';

// Dues under the Membership Policy (Dues page). Each past sample meeting is
// charged as finalizing its attendance charges it (syncMeetingDues: PHP 250
// share capital and PHP 50 savings for everyone on the list, PHP 250 more for
// those absent without a valid reason). Most members paid within three weeks
// of the meeting, fewer for the latest one; a few absence fines were waived by
// the board, and two memberships were transferred (PHP 500 fee). A payment is
// written as the Dues page writes one: the share capital part is also a share
// capital contribution and the savings part a savings deposit, all at once for
// every payment (the seeder may run across the internet).
// Dues are paid in cash only.
const WAIVE_REASONS = ['Hospitalized on the day of the meeting (medical certificate presented)', 'Death in the family; the board accepted the reason'];
const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const stamp = (dayParam, time) => `((${dayParam})::date + TIME '${time}') AT TIME ZONE '${TIME_ZONE}'`;
const centsOf = (amount) => Math.round(Number(amount) * 100);

export default async function seedDues(ctx) {
  const { client, today, admin } = ctx;
  if (!(await client.query(`SELECT to_regclass('public.member_dues') AS t`)).rows[0].t) {
    ctx.skipped('dues: the database has no dues tables yet (migration 069)');
    return;
  }
  const meetings = ctx.activities.filter((activity) => activity.category === 'meeting').sort((a, b) => a.date.localeCompare(b.date));
  for (const meeting of meetings) {
    await syncMeetingDues(client, meeting.id, admin.id, { first: true });
    // Charged when the attendance was finalized, not today.
    const at = [meeting.date, `${meeting.end}:00`];
    await client.query(`UPDATE activities SET dues_charged_at = attendance_finalized_at WHERE id = $1`, [meeting.id]);
    await client.query(`UPDATE member_dues SET created_at = ($2::date + $3::time) AT TIME ZONE '${TIME_ZONE}', updated_at = ($2::date + $3::time) AT TIME ZONE '${TIME_ZONE}' WHERE activity_id = $1`, [meeting.id, ...at]);
    await client.query(
      `UPDATE notifications SET created_at = ($2::date + $3::time) AT TIME ZONE '${TIME_ZONE}' WHERE type = 'dues_charged' AND entity_type = 'activity' AND entity_id = $1::text`,
      [meeting.id, ...at]
    );
  }

  // Two memberships handed on to a family member: the transfer fee, one paid, one not yet.
  const transfers = [ctx.members[40], ctx.members[77]].filter(Boolean).map((member, n) => ({
    member, date: officeDayOnOrBefore(addDays(today, n === 0 ? -150 : -12)), to: `${['Ramon', 'Liza'][n]} ${member.fullName.split(' ').at(-1)} (${['son', 'daughter'][n]})`,
  })).filter((transfer) => transfer.date > transfer.member.membershipDate);
  if (transfers.length) {
    await client.query(
      `INSERT INTO member_dues (member_id, kind, amount, due_date, description, created_by, created_at, updated_at)
       SELECT r.member_id, 'transfer_fee', $3::numeric, r.day, r.description, $4, ${stamp('r.day', '10:00')}, ${stamp('r.day', '10:00')}
       FROM unnest($1::int[], $2::date[], $5::text[]) AS r(member_id, day, description)`,
      [transfers.map((t) => t.member.id), transfers.map((t) => t.date), centsToString(DUES.transfer_fee.cents), admin.id,
        transfers.map((t) => `${DUES.transfer_fee.label}: membership transferred to ${t.to}`)]
    );
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
       SELECT u.id, 'dues_charged', 'Transfer fee', r.message, 'info', '/member/dues', 'member_due', d.id::text, 'dues-transfer-' || d.id, ${stamp('r.day', '10:00')}
       FROM unnest($1::int[], $2::date[], $3::text[]) AS r(member_id, day, message)
       JOIN member_dues d ON d.member_id = r.member_id AND d.kind = 'transfer_fee' AND d.due_date = r.day
       JOIN users u ON u.member_id = r.member_id AND u.account_status = 'ACTIVE'
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [transfers.map((t) => t.member.id), transfers.map((t) => t.date),
        transfers.map((t) => `A ${pesos(DUES.transfer_fee.cents)} transfer fee was added for transferring your membership to ${t.to}. Please pay at the ACIFAC office.`)]
    );
  }

  const ids = ctx.members.map((member) => member.id);
  const dues = (await client.query(
    `SELECT d.id, d.member_id, d.kind, d.amount, d.due_date::text AS due_date, d.activity_id FROM member_dues d
     WHERE d.member_id = ANY($1::int[]) ORDER BY d.member_id, d.due_date, d.id`, [ids]
  )).rows;
  if (!dues.length) return;
  ctx.count('dues', dues.length);

  // Each member's dues of one meeting (or one transfer) are paid together, or not.
  const groups = new Map();
  for (const due of dues) {
    const key = `${due.member_id}|${due.activity_id ?? `t${due.id}`}`;
    const group = groups.get(key) ?? { memberId: Number(due.member_id), activityId: due.activity_id, date: due.due_date, dues: [] };
    group.dues.push(due);
    groups.set(key, group);
  }
  const latestMeeting = meetings.at(-1)?.id;
  const position = new Map(ctx.members.map((member, index) => [member.id, index]));
  const payments = [];
  const waived = [];
  for (const group of groups.values()) {
    const index = position.get(group.memberId) ?? 0;
    const fine = group.dues.find((due) => due.kind === 'absence_fine');
    // The board waived a few fines (the member's other dues were paid).
    let paying = group.dues;
    if (fine && index % 13 === 4) {
      waived.push({ id: fine.id, day: addDays(group.date, 10), reason: WAIVE_REASONS[index % WAIVE_REASONS.length] });
      paying = group.dues.filter((due) => due !== fine);
    }
    const paid = group.activityId === null ? group.date < addDays(today, -60)
      : group.activityId === latestMeeting ? index % 3 !== 1 : index % 11 !== 6;
    if (!paid || !paying.length) continue;
    let day = officeDayOnOrBefore(addDays(group.date, 1 + (index % 20)));
    if (day < group.date) day = group.date;
    if (day > today) continue;
    const sum = (kind) => paying.filter((due) => due.kind === kind).reduce((total, due) => total + centsOf(due.amount), 0);
    payments.push({
      memberId: group.memberId, day, method: DUES_PAYMENT_METHOD, dueIds: paying.map((due) => due.id),
      totalCents: sum('share_capital') + sum('savings') + sum('absence_fine') + sum('transfer_fee'), shareCents: sum('share_capital'), savingsCents: sum('savings'),
    });
  }

  if (waived.length) {
    await client.query(
      `UPDATE member_dues d SET waived_at = ${stamp('r.day', '15:00')}, waived_by = $4, waive_reason = r.reason, updated_at = ${stamp('r.day', '15:00')}
       FROM unnest($1::int[], $2::date[], $3::text[]) AS r(id, day, reason) WHERE d.id = r.id`,
      [waived.map((w) => w.id), waived.map((w) => (w.day > today ? today : w.day)), waived.map((w) => w.reason), admin.id]
    );
    ctx.count('dues waived', waived.length);
  }
  if (!payments.length) return;

  const note = (p) => `Dues paid at the office (${p.dueIds.length} ${p.dueIds.length === 1 ? 'due' : 'dues'}).`;
  // The share capital and savings parts, as the share capital page and the savings page record them.
  const shares = payments.filter((p) => p.shareCents);
  const shareIds = (await client.query(
    `INSERT INTO share_contributions (member_id, amount, contribution_date, payment_method, notes, recorded_by, created_at, updated_at)
     SELECT r.member_id, r.amount, r.day, r.method, r.notes, $5, ${stamp('r.day', '11:00')}, ${stamp('r.day', '11:00')}
     FROM unnest($1::int[], $2::numeric[], $3::date[], $4::text[], $6::text[]) WITH ORDINALITY AS r(member_id, amount, day, method, notes, ord)
     ORDER BY r.ord RETURNING id`,
    [shares.map((p) => p.memberId), shares.map((p) => centsToString(p.shareCents)), shares.map((p) => p.day), shares.map((p) => p.method), admin.id,
      shares.map((p) => `Meeting dues: ${note(p)}`)]
  )).rows.map((row) => row.id);
  shares.forEach((p, i) => { p.shareId = shareIds[i]; });
  const deposits = payments.filter((p) => p.savingsCents);
  const savingsIds = (await client.query(
    `INSERT INTO savings_transactions (member_id, transaction_type, amount, transaction_date, payment_method, notes, recorded_by, created_at)
     SELECT r.member_id, 'deposit', r.amount, r.day, r.method, r.notes, $5, ${stamp('r.day', '11:00')}
     FROM unnest($1::int[], $2::numeric[], $3::date[], $4::text[], $6::text[]) WITH ORDINALITY AS r(member_id, amount, day, method, notes, ord)
     ORDER BY r.ord RETURNING id`,
    [deposits.map((p) => p.memberId), deposits.map((p) => centsToString(p.savingsCents)), deposits.map((p) => p.day), deposits.map((p) => p.method), admin.id,
      deposits.map((p) => `Meeting dues: ${note(p)}`)]
  )).rows.map((row) => row.id);
  deposits.forEach((p, i) => { p.savingsId = savingsIds[i]; });
  // members.share_capital is the sum of the contributions, as the Shares page keeps it.
  await client.query(
    `UPDATE members m SET share_capital = s.total FROM (SELECT member_id, SUM(amount) AS total FROM share_contributions WHERE member_id = ANY($1::int[]) GROUP BY member_id) s WHERE m.id = s.member_id`,
    [[...new Set(shares.map((p) => p.memberId))]]
  );

  const column = (pick) => payments.map(pick);
  const paymentIds = (await client.query(
    `INSERT INTO member_dues_payments (member_id, amount, payment_date, payment_method, notes, share_contribution_id, savings_transaction_id, recorded_by, created_at)
     SELECT r.member_id, r.amount, r.day, r.method, '', r.share_id, r.savings_id, $6, ${stamp('r.day', '11:00')}
     FROM unnest($1::int[], $2::numeric[], $3::date[], $4::text[], $5::int[], $7::int[]) WITH ORDINALITY AS r(member_id, amount, day, method, share_id, savings_id, ord)
     ORDER BY r.ord RETURNING id`,
    [column((p) => p.memberId), column((p) => centsToString(p.totalCents)), column((p) => p.day), column((p) => p.method), column((p) => p.shareId ?? null), admin.id,
      column((p) => p.savingsId ?? null)]
  )).rows.map((row) => row.id);
  payments.forEach((p, i) => { p.id = paymentIds[i]; });
  const links = payments.flatMap((p) => p.dueIds.map((dueId) => [dueId, p.id]));
  await client.query(
    `UPDATE member_dues d SET payment_id = r.payment_id, updated_at = NOW() FROM unnest($1::int[], $2::int[]) AS r(id, payment_id) WHERE d.id = r.id`,
    [links.map(([dueId]) => dueId), links.map(([, paymentId]) => paymentId)]
  );
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, new_values, user_agent, created_at)
     SELECT $1, $2, $3, 'DUES_PAYMENT_RECORDED', 'Dues', 'member_dues_payment', r.id::text,
            'Recorded a dues payment of ' || r.pesos || ' for member ' || m.member_number || ' (' || r.count || CASE WHEN r.count = 1 THEN ' due)' ELSE ' dues)' END,
            jsonb_build_object('member_id', r.member_id, 'amount', r.amount, 'payment_date', r.day, 'payment_method', r.method), $4, ${stamp('r.day', '11:00')}
     FROM unnest($5::int[], $6::int[], $7::numeric[], $8::text[], $9::date[], $10::text[], $11::int[]) AS r(id, member_id, amount, pesos, day, method, count)
     JOIN members m ON m.id = r.member_id`,
    [admin.id, admin.username, admin.role, ctx.req.headers['user-agent'], column((p) => p.id), column((p) => p.memberId), column((p) => centsToString(p.totalCents)),
      column((p) => pesos(p.totalCents)), column((p) => p.day), column((p) => p.method), column((p) => p.dueIds.length)]
  );
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
     SELECT u.id, 'dues_paid', 'Dues payment recorded', r.message, 'success', '/member/dues', 'member_dues_payment', r.id::text, 'dues-payment-' || r.id, ${stamp('r.day', '11:00')}
     FROM unnest($1::int[], $2::int[], $3::text[], $4::date[]) AS r(id, member_id, message, day)
     JOIN users u ON u.member_id = r.member_id AND u.account_status = 'ACTIVE'
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [column((p) => p.id), column((p) => p.memberId),
      column((p) => `A payment of ${pesos(p.totalCents)} for ${p.dueIds.length} ${p.dueIds.length === 1 ? 'due' : 'dues'} was recorded.`), column((p) => p.day)]
  );
  ctx.count('dues payments', payments.length);
}
