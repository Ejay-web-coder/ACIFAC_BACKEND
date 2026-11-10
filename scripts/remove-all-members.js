import '../src/config/env.js';

// Removes EVERY member and everything that belongs to them. Administrator and
// Kadiwa vendor logins stay, and so do machines, rates, Kadiwa products, sales
// and branches, activities, announcements, settings and the About pages.
//
//   npm run remove-all-members            rehearsal: deletes everything inside a
//                                         transaction, prints what it would remove
//                                         and which logins stay, then rolls back
//   npm run remove-all-members -- --apply the same, keeps the result, then deletes
//                                         the members' stored files (photos, IDs,
//                                         RSBSA copies, signatures, scans)
//
// What goes, for every member:
//  - the member record and their member login (sessions, codes, notifications,
//    queued texts go with the login);
//  - loan applications, loans, installments, restructurings and payments;
//  - savings, share capital, attendance and activity invitations, Kadiwa
//    patronage links, machinery bookings and their payments, rental requests and
//    machinery services recorded for a member (non-member rentals stay);
//  - OCR scans of membership and loan forms, and scans posted to the removed
//    savings or machinery records; the AI ID readings of applicants and borrowers;
//  - the activity log entries by, about or for these members and their records.
// Everything happens in one transaction: if anything would break, nothing is removed.
//
// Like the seeder it only runs against a database on this computer, unless
// SEED_ALLOW_REMOTE=true (ACIFAC_BACKEND/.env normally points at the live one).

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

// Every stored-file reference anywhere inside a row (also inside JSON columns).
function collectFiles(value, into) {
  if (typeof value === 'string') { if (STORED.test(value)) into.add(value); }
  else if (Array.isArray(value)) value.forEach((item) => collectFiles(item, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectFiles(item, into));
}

async function removeAllMembers(client) {
  const removed = new Map();
  const files = new Set();
  const run = async (label, sql, params = []) => {
    const { rowCount } = await client.query(sql, params);
    if (rowCount) removed.set(label, (removed.get(label) || 0) + rowCount);
    return rowCount;
  };
  const filesOf = async (sql, params = []) => { for (const row of (await client.query(sql, params)).rows) collectFiles(row, files); };

  await client.query('CREATE TEMP TABLE gone_members ON COMMIT DROP AS SELECT id, member_number FROM members');
  await client.query(`CREATE TEMP TABLE gone_users ON COMMIT DROP AS SELECT id FROM users WHERE role = 'MEMBER' OR member_id IS NOT NULL`);
  const keptBefore = await keptCounts(client);

  // Machinery: bookings and their payments, services of members, rental requests.
  await client.query('CREATE TEMP TABLE gone_rentals ON COMMIT DROP AS SELECT id FROM rental_requests WHERE member_id IN (SELECT id FROM gone_members)');
  await client.query(
    `CREATE TEMP TABLE gone_operations ON COMMIT DROP AS SELECT id FROM machinery_operations
     WHERE member_id IN (SELECT id FROM gone_members) OR rental_request_id IN (SELECT id FROM gone_rentals)`
  );
  await client.query('CREATE TEMP TABLE gone_services ON COMMIT DROP AS SELECT id FROM machinery_services WHERE member_id IN (SELECT id FROM gone_members)');
  await run('machinery rental payments', 'DELETE FROM machinery_rental_payments WHERE operation_id IN (SELECT id FROM gone_operations)');
  await run('machinery bookings', 'DELETE FROM machinery_operations WHERE id IN (SELECT id FROM gone_operations)');
  await run('machinery services of members (with their payments)', 'DELETE FROM machinery_services WHERE id IN (SELECT id FROM gone_services)');
  await run('rental requests', 'DELETE FROM rental_requests WHERE id IN (SELECT id FROM gone_rentals)');

  // Loans: the schedules first (an installment can point at a restructuring).
  await client.query('CREATE TEMP TABLE gone_requests ON COMMIT DROP AS SELECT id FROM loan_requests WHERE member_id IN (SELECT id FROM gone_members)');
  await client.query(
    `CREATE TEMP TABLE gone_loans ON COMMIT DROP AS SELECT id FROM loans
     WHERE member_id IN (SELECT id FROM gone_members) OR loan_request_id IN (SELECT id FROM gone_requests)`
  );
  await filesOf('SELECT row_to_json(r) AS row FROM loan_requests r WHERE id IN (SELECT id FROM gone_requests)');
  await filesOf('SELECT row_to_json(l) AS row FROM loans l WHERE id IN (SELECT id FROM gone_loans)');
  await run('loan installments', 'DELETE FROM loan_installments WHERE loan_id IN (SELECT id FROM gone_loans)');
  await run('loan restructurings', 'DELETE FROM loan_restructurings WHERE loan_id IN (SELECT id FROM gone_loans)');
  await run('loan payments', 'DELETE FROM loan_payments WHERE loan_id IN (SELECT id FROM gone_loans)');
  await run('loans', 'DELETE FROM loans WHERE id IN (SELECT id FROM gone_loans)');
  await run('loan applications', 'DELETE FROM loan_requests WHERE id IN (SELECT id FROM gone_requests)');

  // Savings, share capital, attendance (invitations and Kadiwa patronage links go with the members).
  await client.query('CREATE TEMP TABLE gone_savings ON COMMIT DROP AS SELECT id FROM savings_transactions WHERE member_id IN (SELECT id FROM gone_members)');
  await run('savings transactions', 'DELETE FROM savings_transactions WHERE id IN (SELECT id FROM gone_savings)');
  await run('share capital contributions', 'DELETE FROM share_contributions WHERE member_id IN (SELECT id FROM gone_members)');
  await run('attendance records', 'DELETE FROM activity_attendance WHERE member_id IN (SELECT id FROM gone_members)');
  await run('activity invitations', 'DELETE FROM activity_invitees WHERE member_id IN (SELECT id FROM gone_members)');
  await run('Kadiwa patronage links', 'DELETE FROM kadiwa_sale_members WHERE member_id IN (SELECT id FROM gone_members)');

  // OCR scans of membership and loan forms, and those posted to removed savings or machinery records.
  await client.query(
    `CREATE TEMP TABLE gone_scans ON COMMIT DROP AS SELECT id FROM document_scans
     WHERE detected_document_type IN ('Membership Form', 'Loan Form', 'Loan Application')
        OR posted_module IN ('members', 'loans')
        OR (posted_module = 'savings' AND posted_record_id IN (SELECT id::text FROM gone_savings))
        OR (posted_module = 'machinery' AND (posted_record_id IN (SELECT id::text FROM gone_operations) OR posted_record_id IN (SELECT id::text FROM gone_rentals)))`
  );
  await filesOf('SELECT stored_file_path, id_document_path, photo_path, co_maker_id_path FROM document_scans WHERE id IN (SELECT id FROM gone_scans)');
  await run('OCR scans of member forms', 'DELETE FROM document_scans WHERE id IN (SELECT id FROM gone_scans)');
  await run('AI readings of applicant IDs', 'DELETE FROM member_id_readings');
  await run('AI readings of borrower and co-maker IDs', 'DELETE FROM loan_id_readings');

  // The activity log of these members and their records.
  await run('activity log entries',
    `DELETE FROM audit_logs
     WHERE user_id IN (SELECT id FROM gone_users) OR target_user_id IN (SELECT id FROM gone_users)
        OR (entity_type = 'user' AND entity_id IN (SELECT id::text FROM gone_users))
        OR (entity_type = 'member' AND entity_id IN (SELECT id::text FROM gone_members))
        OR (entity_type IN ('loan_request') AND entity_id IN (SELECT id::text FROM gone_requests))
        OR (entity_type IN ('loan', 'loan_payment') AND entity_id IN (SELECT id::text FROM gone_loans))
        OR entity_type IN ('loan_payment', 'share_contribution', 'activity_attendance')
        OR (entity_type = 'savings_transaction' AND entity_id IN (SELECT id::text FROM gone_savings))
        OR (entity_type = 'rental_request' AND entity_id IN (SELECT id::text FROM gone_rentals))
        OR (entity_type = 'machinery_operation' AND entity_id IN (SELECT id::text FROM gone_operations))
        OR (entity_type = 'machinery_service' AND entity_id IN (SELECT id::text FROM gone_services))
        OR (entity_type = 'document_scan' AND entity_id IN (SELECT id::text FROM gone_scans))`);

  // The logins (sessions, codes, notifications and queued texts go with them), then the members.
  await filesOf('SELECT profile_photo FROM users WHERE id IN (SELECT id FROM gone_users)');
  await filesOf('SELECT id_document_path, profile_photo, signature_paths, rsbsa_document_path FROM members');
  await run('member logins', 'DELETE FROM users WHERE id IN (SELECT id FROM gone_users)');
  await run('members', 'DELETE FROM members');

  const keptAfter = await keptCounts(client);
  const changed = Object.keys(keptBefore).filter((key) => keptBefore[key] !== keptAfter[key]);
  if (changed.length) throw new Error(`Stopped: records that should stay would change (${changed.map((key) => `${key} ${keptBefore[key]} -> ${keptAfter[key]}`).join(', ')}). Nothing was removed.`);
  const keptLogins = (await client.query('SELECT username, role, full_name FROM users ORDER BY role, id')).rows;
  return { removed, files, keptAfter, keptLogins };
}

// Records that must stay, counted before and after.
async function keptCounts(client) {
  return (await client.query(
    `SELECT (SELECT COUNT(*) FROM users WHERE id NOT IN (SELECT id FROM gone_users))::int AS "administrator and vendor logins",
            (SELECT COUNT(*) FROM machinery)::int AS machines,
            (SELECT COUNT(*) FROM machinery_service_rates)::int AS "machinery rates",
            (SELECT COUNT(*) FROM machinery_services WHERE member_id IS NULL)::int AS "non-member machinery services",
            (SELECT COUNT(*) FROM kadiwa_inventory)::int AS "Kadiwa products",
            (SELECT COUNT(*) FROM kadiwa_sales)::int AS "Kadiwa sales",
            (SELECT COUNT(*) FROM activities)::int AS activities,
            (SELECT COUNT(*) FROM announcements)::int AS announcements`
  )).rows[0];
}

const pool = getPool();
const client = await pool.connect();
let files = new Set();
try {
  await client.query('BEGIN');
  const result = await removeAllMembers(client);
  files = result.files;
  console.log(`${apply ? 'Removed' : 'Would remove'} from ${host}:`);
  for (const [label, count] of result.removed) console.log(`  ${String(count).padStart(6)}  ${label}`);
  console.log(`  ${String(files.size).padStart(6)}  stored files (photos, IDs, RSBSA copies, signatures, scans)${apply ? ', deleted next' : ''}`);
  console.log(`Kept: ${Object.entries(result.keptAfter).map(([key, value]) => `${value} ${key}`).join(', ')}.`);
  console.log('Logins that stay:');
  for (const user of result.keptLogins) console.log(`  ${user.role.padEnd(7)} ${user.username}${user.full_name ? ` (${user.full_name})` : ''}`);
  if (!apply) throw new Rehearsal();
  await client.query(
    `INSERT INTO audit_logs (action, module, entity_type, description, new_values, user_agent)
     VALUES ('ALL_MEMBERS_REMOVED', 'System', 'database', 'Removed every member and their records (npm run remove-all-members).', $1::jsonb, 'ACIFAC remove-all-members')`,
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
// Files only after the database change is kept; a file that cannot be removed is reported, not fatal.
for (const reference of files) await removeFile(reference);
if (apply && files.size) console.log(`Deleted ${files.size} stored files.`);
if (apply && !process.exitCode) console.log('Done.');
await pool.end();
