import '../src/config/env.js';

// Removes the sample data that `npm run seed` added, and nothing else:
//
//   npm run remove-sample-data            rehearsal: deletes everything inside a
//                                         transaction, prints what it would remove,
//                                         checks the real records, then rolls back
//   npm run remove-sample-data -- --apply the same, and keeps the result
//
// What is sample data:
//  - every row the seeder's own transaction(s) wrote and nobody changed since
//    (they share that transaction's id, xmin, with the seeder's audit entries);
//  - the sample members (registered by the seeder, emails @example.com) and
//    everything that points at them, also if it was recorded later through the
//    app: their logins, loans and applications, payments, savings, share
//    capital, rentals, machinery services, attendance and notifications;
//  - the seeder's Kadiwa products, by the moment the seeder created them. A
//    product that real sales sold is only marked deleted, as the inventory's own
//    Delete does, so those sales keep their lines.
// Real members, real records, machines, rates, settings and administrators stay.
// Everything happens in one transaction: if any delete would break a real
// record (a foreign key), nothing is removed.
//
// Like the seeder it only runs against a database on this computer, unless
// SEED_ALLOW_REMOTE=true (ACIFAC_BACKEND/.env normally points at the live one).

const SEEDER_AGENT = 'ACIFAC seeder (npm run seed)';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const apply = process.argv.includes('--apply');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!databaseUrl) fail('Set SUPABASE_DB_URL (or DATABASE_URL) to the database to clean.');
let host = '';
try { host = new URL(databaseUrl).hostname; } catch { fail('SUPABASE_DB_URL / DATABASE_URL is not a valid connection string.'); }
const local = LOCAL_HOSTS.has(host);
if (!local && process.env.SEED_ALLOW_REMOTE !== 'true') {
  fail(`Refusing to touch ${host}: it is not a database on this computer. Set SEED_ALLOW_REMOTE=true to clean a database elsewhere on purpose.`);
}
if (local && !process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'disable';

const { getPool } = await import('../src/config/db.js');

class Rehearsal extends Error {}

async function removeSampleData(client) {
  const removed = new Map();
  const run = async (label, sql, params = []) => {
    const { rowCount } = await client.query(sql, params);
    if (rowCount) removed.set(label, (removed.get(label) || 0) + rowCount);
    return rowCount;
  };

  // The seeder's transactions and the moments they ran (NOW() inside them).
  const runs = (await client.query(
    `SELECT DISTINCT xmin::text AS tx FROM audit_logs WHERE user_agent = $1`, [SEEDER_AGENT]
  )).rows.map((row) => row.tx);
  if (!runs.length) return { removed, runs, note: 'No sample data from npm run seed was found.' };
  const seeded = (alias = '') => `${alias ? `${alias}.` : ''}xmin::text = ANY($1::text[])`;

  // The sample members: registered by the seeder, with a made-up @example.com address.
  await client.query(
    `CREATE TEMP TABLE sample_members ON COMMIT DROP AS
     SELECT m.id, m.member_number FROM members m
     WHERE m.email ILIKE '%@example.com'
       AND (${seeded('m')} OR m.id::text IN (SELECT entity_id FROM audit_logs WHERE user_agent = $2 AND action = 'MEMBER_CREATED' AND entity_type = 'member'))`,
    [runs, SEEDER_AGENT]
  );
  await client.query(`CREATE TEMP TABLE sample_users ON COMMIT DROP AS SELECT id FROM users WHERE member_id IN (SELECT id FROM sample_members) AND role = 'MEMBER'`);
  const realBefore = await realCounts(client);

  // Machinery: bookings and their payments, rental requests, services.
  await client.query(
    `CREATE TEMP TABLE sample_rentals ON COMMIT DROP AS
     SELECT id FROM rental_requests WHERE member_id IN (SELECT id FROM sample_members) OR ${seeded()}`, [runs]
  );
  await client.query(
    `CREATE TEMP TABLE sample_operations ON COMMIT DROP AS
     SELECT id FROM machinery_operations
     WHERE member_id IN (SELECT id FROM sample_members) OR rental_request_id IN (SELECT id FROM sample_rentals) OR ${seeded()}`, [runs]
  );
  await run('machinery rental payments', 'DELETE FROM machinery_rental_payments WHERE operation_id IN (SELECT id FROM sample_operations)');
  await run('machinery bookings', 'DELETE FROM machinery_operations WHERE id IN (SELECT id FROM sample_operations)');
  await run('machinery services (with their payments)', `DELETE FROM machinery_services WHERE member_id IN (SELECT id FROM sample_members) OR ${seeded()}`, [runs]);
  await run('rental requests', 'DELETE FROM rental_requests WHERE id IN (SELECT id FROM sample_rentals)');
  await run('machinery expenses', `DELETE FROM machinery_expenses WHERE ${seeded()}`, [runs]);

  // Loans: their schedules first (an installment can point at a restructuring), then the loans and applications.
  await client.query(
    `CREATE TEMP TABLE sample_requests ON COMMIT DROP AS
     SELECT id FROM loan_requests WHERE member_id IN (SELECT id FROM sample_members) OR ${seeded()}`, [runs]
  );
  await client.query(
    `CREATE TEMP TABLE sample_loans ON COMMIT DROP AS
     SELECT id FROM loans WHERE member_id IN (SELECT id FROM sample_members) OR loan_request_id IN (SELECT id FROM sample_requests) OR ${seeded()}`, [runs]
  );
  await run('loan installments', 'DELETE FROM loan_installments WHERE loan_id IN (SELECT id FROM sample_loans)');
  await run('loan restructurings', 'DELETE FROM loan_restructurings WHERE loan_id IN (SELECT id FROM sample_loans)');
  await run('loan payments', 'DELETE FROM loan_payments WHERE loan_id IN (SELECT id FROM sample_loans)');
  await run('loans', 'DELETE FROM loans WHERE id IN (SELECT id FROM sample_loans)');
  await run('loan applications', 'DELETE FROM loan_requests WHERE id IN (SELECT id FROM sample_requests)');

  // Savings, share capital, attendance; the seeder's activities with everyone's attendance at them.
  await run('savings transactions', 'DELETE FROM savings_transactions WHERE member_id IN (SELECT id FROM sample_members)');
  await run('share capital contributions', 'DELETE FROM share_contributions WHERE member_id IN (SELECT id FROM sample_members)');
  await client.query(`CREATE TEMP TABLE sample_activities ON COMMIT DROP AS SELECT id FROM activities WHERE ${seeded()}`, [runs]);
  await run('attendance records', 'DELETE FROM activity_attendance WHERE member_id IN (SELECT id FROM sample_members) OR activity_id IN (SELECT id FROM sample_activities)');
  await run('activities', 'DELETE FROM activities WHERE id IN (SELECT id FROM sample_activities)');
  await run('announcements', `DELETE FROM announcements WHERE ${seeded()}`, [runs]);

  // Kadiwa: the seeder's sales (their lines go with them), then its products.
  await run('Kadiwa sales (with their lines)', `DELETE FROM kadiwa_sales WHERE ${seeded()}`, [runs]);
  // The seeder adds all its products in one statement, so they share one
  // created_at: the moment of the products it wrote that nobody has changed
  // since finds also those whose stock real sales have changed. (Compared in
  // SQL: a JavaScript Date would drop the microseconds.)
  await client.query(
    `CREATE TEMP TABLE sample_products ON COMMIT DROP AS
     SELECT id FROM kadiwa_inventory WHERE ${seeded()} OR created_at IN (SELECT created_at FROM kadiwa_inventory WHERE ${seeded()})`, [runs]
  );
  await run('Kadiwa products marked deleted (real sales sold them)',
    `UPDATE kadiwa_inventory SET deleted_at = COALESCE(deleted_at, NOW())
     WHERE id IN (SELECT id FROM sample_products) AND id IN (SELECT inventory_id FROM kadiwa_sale_items)`);
  await run('Kadiwa products', 'DELETE FROM kadiwa_inventory WHERE id IN (SELECT id FROM sample_products) AND id NOT IN (SELECT inventory_id FROM kadiwa_sale_items)');

  // Notifications and the activity log of the sample records, then the logins and members.
  await run('notifications', `DELETE FROM notifications WHERE user_id IN (SELECT id FROM sample_users) OR ${seeded()}`, [runs]);
  await run('audit log entries',
    `DELETE FROM audit_logs WHERE ${seeded()} OR user_agent = $2 OR user_id IN (SELECT id FROM sample_users) OR target_user_id IN (SELECT id FROM sample_users)
       OR (entity_type = 'member' AND entity_id IN (SELECT id::text FROM sample_members))`, [runs, SEEDER_AGENT]);
  await run('member logins', 'DELETE FROM users WHERE id IN (SELECT id FROM sample_users)');
  await run('members', 'DELETE FROM members WHERE id IN (SELECT id FROM sample_members)');

  const realAfter = await realCounts(client);
  const changed = Object.keys(realBefore).filter((key) => realBefore[key] !== realAfter[key]);
  if (changed.length) throw new Error(`Stopped: real records would change (${changed.map((key) => `${key} ${realBefore[key]} -> ${realAfter[key]}`).join(', ')}). Nothing was removed.`);
  return { removed, runs, realAfter };
}

// Records that are not sample data, counted before and after: they must not change.
async function realCounts(client) {
  const row = (await client.query(
    `SELECT (SELECT COUNT(*) FROM members WHERE id NOT IN (SELECT id FROM sample_members))::int AS members,
            (SELECT COUNT(*) FROM users WHERE id NOT IN (SELECT id FROM sample_users))::int AS logins,
            (SELECT COUNT(*) FROM loans WHERE member_id IS NOT NULL AND member_id NOT IN (SELECT id FROM sample_members))::int AS "member loans",
            (SELECT COUNT(*) FROM savings_transactions WHERE member_id NOT IN (SELECT id FROM sample_members))::int AS "member savings",
            (SELECT COUNT(*) FROM share_contributions WHERE member_id NOT IN (SELECT id FROM sample_members))::int AS "member share capital",
            (SELECT COUNT(*) FROM machinery)::int AS machines,
            (SELECT COUNT(*) FROM machinery_service_rates)::int AS "machinery rates",
            (SELECT COUNT(*) FROM document_scans)::int AS "document scans"`
  )).rows[0];
  return row;
}

const pool = getPool();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const result = await removeSampleData(client);
  if (result.note) {
    console.log(result.note);
    await client.query('ROLLBACK');
  } else {
    console.log(`${apply ? 'Removed' : 'Would remove'} from ${host} (seeder runs: ${result.runs.length}):`);
    for (const [label, count] of result.removed) console.log(`  ${String(count).padStart(6)}  ${label}`);
    console.log(`Real records kept: ${Object.entries(result.realAfter).map(([key, value]) => `${value} ${key}`).join(', ')}.`);
    if (!apply) throw new Rehearsal();
    await client.query(
      `INSERT INTO audit_logs (action, module, entity_type, description, new_values, user_agent)
       VALUES ('SAMPLE_DATA_REMOVED', 'System', 'database', 'Removed the sample data of npm run seed (npm run remove-sample-data).', $1::jsonb, 'ACIFAC remove-sample-data')`,
      [JSON.stringify(Object.fromEntries(result.removed))]
    );
    await client.query('COMMIT');
    console.log('Done.');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  if (error instanceof Rehearsal) console.log('\nRehearsal only: nothing was removed. Run again with --apply to remove it.');
  else {
    console.error(error.message || error);
    process.exitCode = 1;
  }
} finally {
  client.release();
  await pool.end();
}
