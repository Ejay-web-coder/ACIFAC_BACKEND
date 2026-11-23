import '../src/config/env.js';

// Gives ONE member who is already registered (a real member) two years of
// records, so their pages look like a member who uses the cooperative: share
// capital, savings, loans (paid off and current), machinery services and a
// rental, Kadiwa purchases, attendance and dues. What is added and why is
// described in scripts/seeders/memberHistory.js; the member's own details
// (name, address, farm area, membership date) are not changed.
//
//   npm run seed:member -- "Juan Dela Cruz"                 rehearsal: adds it inside a transaction, prints
//                                                           what it would add, then rolls back (nothing is saved)
//   npm run seed:member -- "Juan Dela Cruz" --apply         the same, and keeps it
//   npm run seed:member -- ACIFAC-2024-003 --apply          by member number (when two members share a name)
//   npm run seed:member -- "Juan Dela Cruz" --remove        rehearsal of taking out what this script added
//   npm run seed:member -- "Juan Dela Cruz" --remove --apply
//
// The member is found by member number or by name, with or without the middle
// name, ignoring capitals. It runs once per member (--remove first to run it
// again). npm run remove-sample-data also removes what it added.
// Like npm run seed it only runs against a database on this computer, unless
// SEED_ALLOW_REMOTE=true (ACIFAC_BACKEND/.env normally points at the live one).

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const remove = args.includes('--remove');
const wanted = (args.find((arg) => arg.startsWith('--member='))?.slice('--member='.length) ?? args.filter((arg) => !arg.startsWith('--')).join(' ')).trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!wanted) fail('Name the member: npm run seed:member -- "First Last" (or their member number), with --apply to keep the records.');
const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!databaseUrl) fail('Set SUPABASE_DB_URL (or DATABASE_URL) to the database to fill.');
let host = '';
try { host = new URL(databaseUrl).hostname; } catch { fail('SUPABASE_DB_URL / DATABASE_URL is not a valid connection string.'); }
const local = LOCAL_HOSTS.has(host);
if (process.env.NODE_ENV === 'production') fail('Refusing to seed: NODE_ENV is production.');
if (!local && process.env.SEED_ALLOW_REMOTE !== 'true') {
  fail(`Refusing to touch ${host}: it is not a database on this computer. Set SEED_ALLOW_REMOTE=true to change a database elsewhere on purpose.`);
}
if (local && !process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'disable';

// The controllers import one another; loading the app first loads them in the order the server does.
await import('../src/app.js');
const { getPool } = await import('../src/config/db.js');
const { todayDateOnly } = await import('../src/utils/dates.js');
const { findMembers, HISTORY_ACTION, memberSeederRequest, removeMemberHistory, seedMemberHistory, similarMembers } = await import('./seeders/memberHistory.js');

class Rehearsal extends Error {}
class Stop extends Error {}

const peso = (value) => `PHP ${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
const describeMember = (m) => `${m.full_name} (${m.member_number || `id ${m.id}`}, ${m.status}, member since ${m.membership_date || 'no date'})`;

async function pickMember(client) {
  const found = await findMembers(client, wanted);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new Stop(`${found.length} members match "${wanted}". Run it again with the member number of the one you mean:\n${found.map((m) => `  ${describeMember(m)}`).join('\n')}`);
  }
  const similar = await similarMembers(client, wanted);
  throw new Stop(`No member is called "${wanted}" here.${similar.length ? ` Members with a similar name:\n${similar.map((m) => `  ${describeMember(m)}`).join('\n')}` : ''}`);
}

async function memberTotals(client, member) {
  const totals = (await client.query(
    `SELECT (SELECT share_capital FROM members WHERE id = $1) AS share_capital,
            (SELECT COALESCE(SUM(CASE WHEN transaction_type = 'withdrawal' THEN -amount ELSE amount END), 0) FROM savings_transactions WHERE member_id = $1) AS savings`,
    [member.id]
  )).rows[0];
  const loans = (await client.query(
    `SELECT loan_number, amount, status, balance, date_approved, due_date FROM loans WHERE member_id = $1 ORDER BY date_approved, id`, [member.id]
  )).rows;
  console.log(`  share capital ${peso(totals.share_capital)}, savings ${peso(totals.savings)}`);
  for (const loan of loans) {
    console.log(`  loan ${loan.loan_number}: ${peso(loan.amount)}, approved ${loan.date_approved}, due ${loan.due_date}, ${loan.status}${Number(loan.balance) > 0 ? `, balance ${peso(loan.balance)}` : ''}`);
  }
}

async function run(client) {
  const member = await pickMember(client);
  console.log(`Member: ${describeMember(member)}, farm area ${member.farm_area_ha ?? 'not recorded'} ha.`);
  if (remove) {
    const { removed, members } = await removeMemberHistory(client, { memberId: member.id });
    if (!members.length) throw new Stop('npm run seed:member has added nothing to this member: nothing to remove.');
    console.log(`\n${apply ? 'Removed' : 'Would remove'} from ${host}:`);
    for (const [label, count] of removed) console.log(`  ${String(count).padStart(5)}  ${label}`);
    await client.query(
      `INSERT INTO audit_logs (action, module, entity_type, entity_id, description, new_values, user_agent)
       VALUES ('MEMBER_HISTORY_REMOVED', 'System', 'member', $1, $2, $3::jsonb, 'ACIFAC member seeder (npm run seed:member -- --remove)')`,
      [String(member.id), `Removed the sample records npm run seed:member added to member ${member.member_number}.`, JSON.stringify(Object.fromEntries(removed))]
    );
    console.log('The member now has:');
    await memberTotals(client, member);
    return;
  }

  if (member.status !== 'active') throw new Stop(`Only an active member gets records: this one is ${member.status}.`);
  if (!member.membership_date) throw new Stop('The member has no membership date: records are dated from it.');
  const earlier = (await client.query(
    `SELECT created_at, COALESCE(new_values -> 'counts', '{}'::jsonb) = '{}'::jsonb AS empty FROM audit_logs WHERE action = $1 AND entity_type = 'member' AND entity_id = $2 ORDER BY id`,
    [HISTORY_ACTION, String(member.id)]
  )).rows;
  const already = earlier.find((run) => !run.empty);
  if (already) throw new Stop(`This member already got their records (${new Date(already.created_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}). To add them again, run with --remove --apply first.`);
  // An earlier run that added nothing (the membership date left no days to fill) does not count.
  if (earlier.length) await removeMemberHistory(client, { memberId: member.id });
  const admin = (await client.query(`SELECT id, username, role, full_name FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' ORDER BY id LIMIT 1`)).rows[0];
  if (!admin) throw new Stop('No active administrator here to record the entries.');
  const login = (await client.query(`SELECT username FROM users WHERE member_id = $1 AND account_status = 'ACTIVE' ORDER BY id LIMIT 1`, [member.id])).rows[0];

  const counts = new Map();
  const skipped = [];
  const ctx = {
    client, today: todayDateOnly(), admin, req: memberSeederRequest(admin), member, counts,
    count(label, amount = 1) { counts.set(label, (counts.get(label) || 0) + amount); },
    skipped(reason) { skipped.push(reason); },
  };
  const started = Date.now();
  await seedMemberHistory(ctx);
  if (!counts.size) {
    throw new Stop(`Nothing to add, so nothing was saved: records are dated from a week after the membership date (${member.membership_date}), and that leaves `
      + `${ctx.start > ctx.today ? 'no days' : `only ${ctx.start} to ${ctx.today}`}${skipped.length ? ` (${skipped.join('; ')})` : ''}. `
      + 'If the member joined earlier, correct the membership date on their page (Members > Edit) and run this again.');
  }
  console.log(`\n${apply ? 'Added' : 'Would add'} on ${host} (from ${ctx.start} to ${ctx.today}, entered by ${admin.username}):`);
  for (const [label, amount] of counts) console.log(`  ${String(amount).padStart(5)}  ${label}`);
  for (const reason of skipped) console.log(`  skipped: ${reason}`);
  if (ctx.start > addYearsAgo(ctx.today, 2)) console.log(`  (records start ${ctx.start}, a week after the membership date ${member.membership_date}: correct the date on the member's page first if it is wrong)`);
  console.log(`The member then has:`);
  await memberTotals(client, member);
  console.log(login
    ? `Their login ${login.username} gets the notifications of these records, already marked read (none is texted, emailed or sent to a phone).`
    : 'The member has no login yet: the records show on their member page for the office.');
  console.log(`(${Math.round((Date.now() - started) / 1000)} s)`);
}

function addYearsAgo(day, years) {
  return `${Number(day.slice(0, 4)) - years}${day.slice(4)}`;
}

const pool = getPool();
const client = await pool.connect();
// Counted, so the time a run across the internet takes (about 0.3 s each) can be told.
let roundTrips = 0;
const send = client.query.bind(client);
client.query = (...queryArgs) => { roundTrips += 1; return send(...queryArgs); };
process.on('exit', () => { if (roundTrips) console.log(`(${roundTrips} database round trips)`); });
try {
  await client.query('BEGIN');
  await run(client);
  if (!apply) throw new Rehearsal();
  await client.query('COMMIT');
  console.log('Done.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  if (error instanceof Rehearsal) console.log(`\nRehearsal only: nothing was saved. Run again with --apply to keep it.`);
  else {
    console.error(error instanceof Stop ? error.message : `Stopped, nothing was saved: ${error.message || error}`);
    process.exitCode = 1;
  }
} finally {
  client.release();
  await pool.end();
}
