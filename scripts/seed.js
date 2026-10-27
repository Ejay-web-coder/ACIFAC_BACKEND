import '../src/config/env.js';

// Fills a database with sample data for development and demonstrations:
// members with share capital and savings, loans with payments (on time, late,
// overdue, paid off), machinery services and rentals, Kadiwa sales,
// activities with attendance, and announcements.
//
//   npm run seed              migrate, then fill a database that has no members yet
//   npm run seed -- --fresh   empty a LOCAL database first (all tables), then the same
//   npm run seed -- --add-members=500
//                             also add 500 members, each with an active login (member001 ...);
//                             on a database this seeder already filled, adds only them
//   npm run seed -- --alongside-existing
//                             add the sample data to a database that already has real
//                             members, without touching their records (see below)
//
// ACIFAC_BACKEND/.env points at the live database, so the seeder only runs
// against a database on this computer unless told otherwise:
//   SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/acifac_dev npm run seed
//   PowerShell: $env:SUPABASE_DB_URL='postgres://...'; npm run seed; Remove-Item Env:SUPABASE_DB_URL
// It adds sample records to a database that already has members only with
// --alongside-existing. Then nothing that real members or the office would act
// on is added: no announcements, no activity still to come, no rental from
// today on (it could block a real booking), and real members get no
// attendance records; only the sample loans are brought up to date. Totals,
// reports and net income do include the sample records.
// To fill a database elsewhere (Supabase) on purpose, set SEED_ALLOW_REMOTE=true
// and choose the passwords with SEED_ADMIN_PASSWORD and SEED_MEMBER_PASSWORD
// (an existing administrator keeps their own password).
//
// Each file in scripts/seeders/ fills one part of the system and runs in the
// order of SEEDERS below, all in one transaction: if any part fails, nothing
// is saved. To add a seeder, write scripts/seeders/<name>.js exporting
// `async function (ctx)` and add it to SEEDERS (see ctx in createContext).

const SEEDERS = [
  ['members and share capital', './seeders/members.js'],
  ['savings', './seeders/savings.js'],
  ['loans', './seeders/loans.js'],
  ['loan history', './seeders/loanHistory.js'],
  ['machinery', './seeders/machinery.js'],
  ['Kadiwa store', './seeders/kadiwa.js'],
  ['activities and attendance', './seeders/attendance.js'],
  ['announcements', './seeders/announcements.js'],
];

const fresh = process.argv.includes('--fresh');
const alongsideExisting = process.argv.includes('--alongside-existing');
const addMembersArg = process.argv.find((arg) => arg.startsWith('--add-members'));
const addMembers = addMembersArg === undefined ? 0 : Number(addMembersArg.split('=')[1] ?? process.argv[process.argv.indexOf(addMembersArg) + 1]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_PASSWORDS = { admin: 'Admin@12345', member: 'Member@12345' };

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (addMembersArg !== undefined && (!Number.isInteger(addMembers) || addMembers < 1 || addMembers > 20000)) fail('Use --add-members=N with N from 1 to 20000.');

// Same choice of database as src/config/db.js.
const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!databaseUrl) fail('Set SUPABASE_DB_URL (or DATABASE_URL) to the database to fill.');
let host = '';
try { host = new URL(databaseUrl).hostname; } catch { fail('SUPABASE_DB_URL / DATABASE_URL is not a valid connection string.'); }
const local = LOCAL_HOSTS.has(host);

if (process.env.NODE_ENV === 'production') fail('Refusing to seed: NODE_ENV is production.');
if (!local && process.env.SEED_ALLOW_REMOTE !== 'true') {
  const example = 'postgres://postgres:PASSWORD@localhost:5432/acifac_dev';
  fail(`Refusing to seed ${host}: it is not a database on this computer (your .env normally points at the live one).\n`
    + 'Point the seeder at a local database for this one command, for example:\n'
    + (process.platform === 'win32'
      ? `  PowerShell:  $env:SUPABASE_DB_URL='${example}'; npm run seed; Remove-Item Env:SUPABASE_DB_URL\n`
        + `  cmd:         set SUPABASE_DB_URL=${example}&& npm run seed & set SUPABASE_DB_URL=\n`
      : `  SUPABASE_DB_URL=${example} npm run seed\n`)
    + 'To fill a database elsewhere on purpose, set SEED_ALLOW_REMOTE=true with SEED_ADMIN_PASSWORD and SEED_MEMBER_PASSWORD.');
}
if (!local && fresh) fail('--fresh empties every table, so it only runs on a local database.');
if (!local && (!process.env.SEED_ADMIN_PASSWORD || !process.env.SEED_MEMBER_PASSWORD)) {
  fail('A database others can reach needs its own passwords: set SEED_ADMIN_PASSWORD and SEED_MEMBER_PASSWORD.');
}
// A local PostgreSQL usually has no TLS (see DATABASE_SSL in .env.example).
if (local && !process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'disable';

// The controllers import one another (memberController, documentRouting, ...);
// loading the app first loads them in the order the server does.
await import('../src/app.js');
const { getPool, withTransaction } = await import('../src/config/db.js');
const { applyMigrations } = await import('../src/services/migrations.js');
const { todayDateOnly } = await import('../src/utils/dates.js');
const { validatePasswordPolicy } = await import('../src/utils/password.js');
const { createAuditLog } = await import('../src/utils/audit.js');
const { seedAdmin } = await import('./seeders/accounts.js');
const { default: addBulkMembers } = await import('./seeders/bulkMembers.js');

const passwords = {
  admin: process.env.SEED_ADMIN_PASSWORD || DEFAULT_PASSWORDS.admin,
  member: process.env.SEED_MEMBER_PASSWORD || DEFAULT_PASSWORDS.member,
};
for (const [who, password] of Object.entries(passwords)) {
  const policy = validatePasswordPolicy(password);
  if (!policy.isValid) fail(`SEED_${who.toUpperCase()}_PASSWORD rejected: ${policy.errors.join(' ')}`);
}

// What every seeder receives.
function createContext(client) {
  const counts = new Map();
  const skipped = [];
  const ctx = {
    client,                    // the open transaction: use client.query, never the pool
    today: todayDateOnly(),    // YYYY-MM-DD in the cooperative's time zone
    passwords,
    admin: null,               // { id, username, role, full_name }: who records everything
    req: null,                 // the admin as the app's controller helpers expect a request
    alongside: false,          // true when real members are there too (--alongside-existing)
    members: [],               // { id, key, memberNumber, fullName, email, phone, address, farmArea, membershipDate }
    loanIds: [],               // the sample loans
    logins: [],                // [role, username, password] to print at the end
    member(key) {
      const found = ctx.members.find((member) => member.key === key);
      if (!found) throw new Error(`No sample member "${key}".`);
      return found;
    },
    count(label, amount = 1) { counts.set(label, (counts.get(label) || 0) + amount); },
    skipped(reason) { skipped.push(reason); },
    counts,
    skippedList: skipped,
  };
  return ctx;
}

async function seed(pool) {
  if (fresh) {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    console.log(`Emptied the local database on ${host}.`);
  }
  await applyMigrations();

  const existing = (await pool.query('SELECT COUNT(*)::int AS count FROM members')).rows[0].count;
  const seeded = (await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'DATABASE_SEEDED' LIMIT 1`)).rows.length > 0;
  // More members alone are added only to a database this seeder filled.
  const onlyAdd = existing > 0 && addMembers > 0 && seeded;
  if (existing > 0 && !onlyAdd && (seeded || !alongsideExisting)) {
    console.error(seeded
      ? 'This database already has the sample data. Use --add-members=N to add more members.'
      : `This database already has ${existing} member${existing === 1 ? '' : 's'}. The seeder only fills a database without members, so sample records `
        + `never mix with real ones${local ? ' (run `npm run seed -- --fresh` to empty it first)' : ''}, unless you pass --alongside-existing.`);
    process.exitCode = 1;
    return;
  }

  let roundTrips = 0;
  const ctx = await withTransaction(async (client) => {
    // Counted, so the cost of a run across the internet (about 0.5 s each) can be told.
    const send = client.query.bind(client);
    client.query = (...args) => { roundTrips += 1; return send(...args); };
    const context = createContext(client);
    context.alongside = existing > 0 && !onlyAdd;
    await seedAdmin(context);
    if (!onlyAdd) {
      for (const [label, file] of SEEDERS) {
        const { default: seed } = await import(file);
        await seed(context);
        console.log(`  seeded ${label}`);
      }
    }
    if (addMembers) {
      await addBulkMembers(context, addMembers);
      console.log(`  added ${addMembers} members with logins`);
    }
    if (context.alongside) {
      // The office's bell is for real work: notifications about the sample records come already read.
      await client.query(`UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL AND created_at = NOW() AND user_id IN (SELECT id FROM users WHERE role = 'ADMIN')`);
    }
    await createAuditLog({
      client, user: context.req.user, action: onlyAdd ? 'SAMPLE_MEMBERS_ADDED' : 'DATABASE_SEEDED', module: 'System', entityType: 'database',
      description: onlyAdd ? `Added ${addMembers} sample members with logins (npm run seed).` : 'Filled the database with sample data (npm run seed).',
      newValues: Object.fromEntries(context.counts), userAgent: context.req.headers['user-agent'],
    });
    return context;
  });

  console.log(`\nSample data added to ${host}:`);
  for (const [label, amount] of ctx.counts) console.log(`  ${String(amount).padStart(4)}  ${label}`);
  for (const reason of ctx.skippedList) console.log(`  skipped: ${reason}`);
  console.log(`  (${roundTrips} database round trips)`);
  console.log('\nSign in with:');
  for (const [role, username, password] of ctx.logins) console.log(`  ${role.padEnd(13)} ${username.padEnd(15)} ${password}`);
}

const pool = getPool();
// Node reports a refused connection as an AggregateError with an empty message.
function describe(error) {
  if (error.code === 'ECONNREFUSED') {
    const { hostname, port } = new URL(databaseUrl);
    return `nothing answers at ${hostname}:${port || 5432}. Is that PostgreSQL running?`;
  }
  return error.message || (error.errors || []).map((inner) => inner.message).join('; ') || String(error);
}

try {
  await seed(pool);
} catch (error) {
  console.error(`Seeding failed, no sample data was saved: ${describe(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
