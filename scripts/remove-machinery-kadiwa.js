import '../src/config/env.js';

// Removes ALL machinery and Kadiwa Store data:
//  - Machinery: the machines and their service rates, bookings and their
//    payments, rental requests, services and their payments, expenses, period
//    balances and the PhilMech report forms.
//  - Kadiwa Store: the products, every sale with its goods, items, expenses and
//    patronage links, and every branch except the main one (id 1), which stays
//    so vendor logins keep working (their branch is set back to it).
//  - OCR scans of these forms, and the notifications and activity log entries
//    about these records.
// Logins, members, loans, savings, activities, announcements and settings stay.
//
//   npm run remove-machinery-kadiwa            rehearsal: deletes inside a
//                                              transaction, prints the counts, rolls back
//   npm run remove-machinery-kadiwa -- --apply the same, keeps the result, then
//                                              deletes the scans' stored files
//
// Only against a database on this computer, unless SEED_ALLOW_REMOTE=true.

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
const { removeFile } = await import('../src/services/storage.js');

class Rehearsal extends Error {}
const STORED = /^(supabase|local):\/\/[^/]+\/.+$/;
const ENTITY_TYPES = [
  'machinery', 'machinery_operation', 'machinery_service', 'machinery_service_payment', 'machinery_service_rate', 'machinery_expense',
  'machinery_report_form', 'machinery_period_balance', 'rental_request',
  'kadiwa_sale', 'kadiwa_inventory', 'kadiwa_branch',
];
const SCAN_TYPES = ['Machinery Form', 'Add Inventory Form', 'Kadiwa Daily Sales Form', 'Kadiwa Sales Form'];

async function removeMachineryAndKadiwa(client) {
  const removed = new Map();
  const files = new Set();
  const run = async (label, sql, params = []) => {
    const { rowCount } = await client.query(sql, params);
    if (rowCount) removed.set(label, (removed.get(label) || 0) + rowCount);
  };
  const keptBefore = await keptCounts(client);

  // Machinery, children first.
  await run('machinery rental payments', 'DELETE FROM machinery_rental_payments');
  await run('machinery bookings', 'DELETE FROM machinery_operations');
  await run('machinery services (with their payments)', 'DELETE FROM machinery_services');
  await run('rental requests', 'DELETE FROM rental_requests');
  await run('machinery expenses', 'DELETE FROM machinery_expenses');
  await run('machinery period balances', 'DELETE FROM machinery_period_balances');
  await run('PhilMech report forms', 'DELETE FROM machinery_report_forms');
  await run('machinery service rates', 'DELETE FROM machinery_service_rates');
  await client.query('UPDATE machinery SET parent_machinery_id = NULL WHERE parent_machinery_id IS NOT NULL');
  await run('machines', 'DELETE FROM machinery');

  // Kadiwa: sales (goods, items, expenses and patronage links go with them), products, extra branches.
  await run('Kadiwa sales (with their lines)', 'DELETE FROM kadiwa_sales');
  await run('Kadiwa products', 'DELETE FROM kadiwa_inventory');
  await client.query(`UPDATE users SET kadiwa_branch_id = 1 WHERE kadiwa_branch_id IS NOT NULL AND kadiwa_branch_id <> 1`);
  await run('Kadiwa branches (the main one stays)', 'DELETE FROM kadiwa_branches WHERE id <> 1');

  // OCR scans of these forms, then notifications and the activity log.
  const scans = (await client.query(
    `SELECT id, stored_file_path FROM document_scans
     WHERE detected_document_type = ANY($1::text[]) OR posted_module IN ('machinery', 'kadiwa')`, [SCAN_TYPES]
  )).rows;
  scans.forEach((scan) => { if (STORED.test(scan.stored_file_path || '')) files.add(scan.stored_file_path); });
  await run('OCR scans of machinery and Kadiwa forms', 'DELETE FROM document_scans WHERE id = ANY($1::bigint[])', [scans.map((scan) => scan.id)]);
  await run('notifications', `DELETE FROM notifications WHERE entity_type = ANY($1::text[]) OR type LIKE 'kadiwa_%' OR type LIKE 'machinery_%' OR type LIKE 'rental_%'`, [ENTITY_TYPES]);
  await run('activity log entries', `DELETE FROM audit_logs WHERE entity_type = ANY($1::text[]) OR (entity_type = 'document_scan' AND entity_id = ANY($2::text[]))`,
    [ENTITY_TYPES, scans.map((scan) => String(scan.id))]);

  const keptAfter = await keptCounts(client);
  const changed = Object.keys(keptBefore).filter((key) => keptBefore[key] !== keptAfter[key]);
  if (changed.length) throw new Error(`Stopped: records that should stay would change (${changed.map((key) => `${key} ${keptBefore[key]} -> ${keptAfter[key]}`).join(', ')}). Nothing was removed.`);
  const left = (await client.query(
    `SELECT (SELECT COUNT(*) FROM machinery)::int AS machines, (SELECT COUNT(*) FROM kadiwa_inventory)::int AS products,
            (SELECT COUNT(*) FROM kadiwa_sales)::int AS sales, (SELECT string_agg(name, ', ') FROM kadiwa_branches) AS branches`
  )).rows[0];
  return { removed, files, keptAfter, left };
}

// Records that must stay, counted before and after.
async function keptCounts(client) {
  return (await client.query(
    `SELECT (SELECT COUNT(*) FROM users)::int AS logins,
            (SELECT COUNT(*) FROM members)::int AS members,
            (SELECT COUNT(*) FROM loans)::int AS loans,
            (SELECT COUNT(*) FROM savings_transactions)::int AS savings,
            (SELECT COUNT(*) FROM activities)::int AS activities,
            (SELECT COUNT(*) FROM announcements)::int AS announcements`
  )).rows[0];
}

const pool = getPool();
const client = await pool.connect();
let files = new Set();
try {
  await client.query('BEGIN');
  const result = await removeMachineryAndKadiwa(client);
  files = result.files;
  console.log(`${apply ? 'Removed' : 'Would remove'} from ${host}:`);
  for (const [label, count] of result.removed) console.log(`  ${String(count).padStart(6)}  ${label}`);
  if (!result.removed.size) console.log('  nothing: there is no machinery or Kadiwa data.');
  console.log(`  ${String(files.size).padStart(6)}  stored scan files${apply ? ', deleted next' : ''}`);
  console.log(`Left: ${result.left.machines} machines, ${result.left.products} Kadiwa products, ${result.left.sales} Kadiwa sales; branches: ${result.left.branches || 'none'}.`);
  console.log(`Kept: ${Object.entries(result.keptAfter).map(([key, value]) => `${value} ${key}`).join(', ')}.`);
  if (!apply) throw new Rehearsal();
  await client.query(
    `INSERT INTO audit_logs (action, module, entity_type, description, new_values, user_agent)
     VALUES ('MACHINERY_KADIWA_DATA_REMOVED', 'System', 'database', 'Removed all machinery and Kadiwa Store data (npm run remove-machinery-kadiwa).', $1::jsonb, 'ACIFAC remove-machinery-kadiwa')`,
    [JSON.stringify(Object.fromEntries(result.removed))]
  );
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  files = new Set();
  if (error instanceof Rehearsal) console.log('\nRehearsal only: nothing was removed. Run again with --apply to remove it.');
  else {
    console.error(error.message || error);
    process.exitCode = 1;
  }
} finally {
  client.release();
}
for (const reference of files) await removeFile(reference);
if (apply && files.size) console.log(`Deleted ${files.size} stored files.`);
if (apply && !process.exitCode) console.log('Done.');
await pool.end();
