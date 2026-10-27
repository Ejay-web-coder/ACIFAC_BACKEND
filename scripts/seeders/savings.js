import { TIME_ZONE } from '../../src/config/env.js';
import { centsToString, toCents } from '../../src/utils/money.js';
import { addDays, addMonths } from './support.js';

// Monthly savings deposits for the last twelve months (or since the member
// joined; one member in nine does not save), and withdrawals that leave more
// than the PHP 500 maintaining balance. Each deposit is written as the Savings page writes one (the record,
// an audit entry, the member's notification), but all of them at once: the
// seeder may run against a database across the internet.
const MONTHLY_DEPOSIT = ['1000', '1500', '500', '300', '800', '500', '700', '1200', '400', '300', '600', '500', '300', '500', '300'];
const WITHDRAWALS = [{ key: 'juan', monthsAgo: 2, amount: '2000' }, { key: 'rosario', monthsAgo: 1, amount: '1000' }, { key: 'antonio', monthsAgo: 3, amount: '1500' }];
const MAINTAINING_CENTS = 50000;
const pesos = (cents) => `PHP ${Number(centsToString(cents)).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const stamp = (dayParam, time) => `((${dayParam})::date + TIME '${time}') AT TIME ZONE '${TIME_ZONE}'`;

export default async function seedSavings(ctx) {
  const { client, today, admin } = ctx;
  // Every deposit and withdrawal, in date order per member, with the balance after it.
  const entries = [];
  for (const [index, member] of ctx.members.entries()) {
    if (index % 9 === 8) continue;
    for (let monthsAgo = 12; monthsAgo >= 0; monthsAgo -= 1) {
      // Some members skip a month now and then.
      if ((index + monthsAgo) % 7 === 3 && monthsAgo > 0) continue;
      const date = addDays(addMonths(today, -monthsAgo), -((index * 3) % 9));
      if (date < member.membershipDate || date > today) continue;
      entries.push({ member, kind: 'deposit', date, cents: toCents(MONTHLY_DEPOSIT[index % MONTHLY_DEPOSIT.length]), method: index % 4 === 3 ? 'GCash' : 'Cash', notes: 'Monthly savings', time: '10:00' });
    }
  }
  // Every seventh generated member also took some savings out, 2 to 6 months ago.
  const generatedWithdrawals = ctx.members.filter((member, index) => index >= 15 && index % 7 === 0)
    .map((member, n) => ({ key: member.key, monthsAgo: 2 + (n % 5), amount: ['500', '1000', '800'][n % 3] }));
  for (const withdrawal of [...WITHDRAWALS, ...generatedWithdrawals]) {
    const member = ctx.member(withdrawal.key);
    const date = addMonths(today, -withdrawal.monthsAgo);
    const balance = entries.filter((entry) => entry.member === member && entry.date <= date).reduce((sum, entry) => sum + (entry.kind === 'deposit' ? entry.cents : -entry.cents), 0);
    if (balance - toCents(withdrawal.amount) < MAINTAINING_CENTS) continue;
    entries.push({ member, kind: 'withdrawal', date, cents: toCents(withdrawal.amount), method: 'Cash', notes: 'Withdrawn at the office', time: '14:00' });
  }
  entries.sort((a, b) => a.member.id - b.member.id || a.date.localeCompare(b.date) || (a.kind === 'deposit' ? -1 : 1));
  const totals = new Map();
  for (const entry of entries) {
    entry.before = totals.get(entry.member.id) || 0;
    entry.after = entry.before + (entry.kind === 'deposit' ? entry.cents : -entry.cents);
    totals.set(entry.member.id, entry.after);
  }
  if (!entries.length) return;

  const column = (pick) => entries.map(pick);
  const ids = (await client.query(
    `INSERT INTO savings_transactions (member_id, transaction_type, amount, transaction_date, payment_method, notes, recorded_by, created_at)
     SELECT r.member_id, r.kind, r.amount, r.day, r.method, r.notes, $7, (r.day + r.at) AT TIME ZONE '${TIME_ZONE}'
     FROM unnest($1::int[], $2::text[], $3::numeric[], $4::date[], $5::text[], $6::text[], $8::time[]) WITH ORDINALITY AS r(member_id, kind, amount, day, method, notes, at, ord)
     ORDER BY r.ord
     RETURNING id`,
    [column((e) => e.member.id), column((e) => e.kind), column((e) => centsToString(e.cents)), column((e) => e.date), column((e) => e.method), column((e) => e.notes),
      admin.id, column((e) => e.time)]
  )).rows.map((row) => row.id);
  entries.forEach((entry, index) => { entry.id = ids[index]; });

  // The deposits' audit entries, as the Savings page writes them (withdrawals were recorded at the counter).
  const deposits = entries.filter((entry) => entry.kind === 'deposit');
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id, description, old_values, new_values, user_agent, created_at)
     SELECT $1, $2, $3, 'SAVINGS_DEPOSIT_CREATED', 'Savings', 'savings_transaction', r.id::text, 'Recorded savings deposit for member ' || r.member_number,
            jsonb_build_object('total_savings', r.before), jsonb_build_object('member_id', r.member_id, 'amount', r.amount, 'total_savings', r.after, 'date', r.day, 'payment_method', r.method),
            $4, ${stamp('r.day', '10:00')}
     FROM unnest($5::int[], $6::text[], $7::int[], $8::numeric[], $9::numeric[], $10::numeric[], $11::date[], $12::text[]) AS r(id, member_number, member_id, amount, before, after, day, method)`,
    [admin.id, admin.username, admin.role, ctx.req.headers['user-agent'], deposits.map((e) => e.id), deposits.map((e) => e.member.memberNumber), deposits.map((e) => e.member.id),
      deposits.map((e) => centsToString(e.cents)), deposits.map((e) => centsToString(e.before)), deposits.map((e) => centsToString(e.after)), deposits.map((e) => e.date), deposits.map((e) => e.method)]
  );
  // The member's notification for each deposit, on their own login.
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key, created_at)
     SELECT u.id, 'savings_recorded', 'Savings deposit recorded', r.message, 'success', '/member-profile', 'savings_transaction', r.id::text, 'savings-' || r.id, ${stamp('r.day', '10:00')}
     FROM unnest($1::int[], $2::int[], $3::text[], $4::date[]) AS r(id, member_id, message, day)
     JOIN users u ON u.member_id = r.member_id AND u.account_status = 'ACTIVE'
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [deposits.map((e) => e.id), deposits.map((e) => e.member.id), deposits.map((e) => `A savings deposit of ${pesos(e.cents)} was recorded. Your total savings are ${pesos(e.after)}.`), deposits.map((e) => e.date)]
  );
  ctx.count('savings deposits', deposits.length);
  if (entries.length > deposits.length) ctx.count('savings withdrawals', entries.length - deposits.length);
}
