// What `npm run seed:member` (scripts/seeders/memberHistory.js) adds to a real
// member is recorded in one audit entry, HISTORY_ACTION, with the ids of every
// row it wrote; removeMemberHistory takes exactly those rows out again. Kept
// apart from the seeder (which loads the app's controllers) so
// remove-sample-data can use it on its own.

export const MEMBER_SEEDER_AGENT = 'ACIFAC member seeder (npm run seed:member)';
export const HISTORY_ACTION = 'MEMBER_HISTORY_SEEDED';

const tableExists = async (client, table) => Boolean((await client.query('SELECT to_regclass($1) AS t', [`public.${table}`])).rows[0].t);

/**
 * Removes what seedMemberHistory added (all members, or one), in the caller's
 * transaction: the rows it recorded, with what the app added to its loans and
 * bookings since (payments, schedules, reminders, payment reports). Returns a
 * Map label -> rows removed and the members it was removed from.
 */
export async function removeMemberHistory(client, { memberId = null } = {}) {
  const entries = (await client.query(
    `SELECT id, entity_id, new_values FROM audit_logs WHERE action = $1 AND entity_type = 'member' AND ($2::text IS NULL OR entity_id = $2::text) ORDER BY id`,
    [HISTORY_ACTION, memberId === null ? null : String(memberId)]
  )).rows;
  const removed = new Map();
  const run = async (label, sql, values) => {
    if (!values.length) return;
    const { rowCount } = await client.query(sql, [values]);
    if (rowCount) removed.set(label, (removed.get(label) || 0) + rowCount);
  };
  const submissions = await tableExists(client, 'payment_submissions');
  for (const entry of entries) {
    const ids = entry.new_values?.ids || {};
    const list = (table) => (ids[table] || []).map(Number).filter(Number.isInteger);
    const loans = list('loans');
    await run('dues', 'DELETE FROM member_dues WHERE id = ANY($1::int[])', list('member_dues'));
    await run('dues payments', 'DELETE FROM member_dues_payments WHERE id = ANY($1::int[])', list('member_dues_payments'));
    if (submissions) await run('online payment reports for those loans', 'DELETE FROM payment_submissions WHERE loan_id = ANY($1::int[])', loans);
    await run('loan installments', 'DELETE FROM loan_installments WHERE loan_id = ANY($1::int[])', loans);
    await run('loan restructurings', 'DELETE FROM loan_restructurings WHERE loan_id = ANY($1::int[])', loans);
    await run('loan payments', 'DELETE FROM loan_payments WHERE loan_id = ANY($1::int[])', loans);
    await run('notifications', `DELETE FROM notifications WHERE entity_type = 'loan' AND entity_id = ANY($1::text[])`, loans.map(String));
    await run('loans', 'DELETE FROM loans WHERE id = ANY($1::int[])', loans);
    await run('loan applications', 'DELETE FROM loan_requests WHERE id = ANY($1::int[])', list('loan_requests'));
    const operations = list('machinery_operations');
    await run('machinery rental payments', 'DELETE FROM machinery_rental_payments WHERE operation_id = ANY($1::int[])', operations);
    await run('machinery bookings', 'DELETE FROM machinery_operations WHERE id = ANY($1::int[])', operations);
    await run('rental requests', 'DELETE FROM rental_requests WHERE id = ANY($1::int[])', list('rental_requests'));
    await run('machinery services (with their payments)', 'DELETE FROM machinery_services WHERE id = ANY($1::int[])', list('machinery_services'));
    await run('Kadiwa purchases', 'DELETE FROM kadiwa_sale_members WHERE id = ANY($1::bigint[])', list('kadiwa_sale_members'));
    await run('attendance records', 'DELETE FROM activity_attendance WHERE id = ANY($1::int[])', list('activity_attendance'));
    await run('savings transactions', 'DELETE FROM savings_transactions WHERE id = ANY($1::int[])', list('savings_transactions'));
    await run('share capital contributions', 'DELETE FROM share_contributions WHERE id = ANY($1::int[])', list('share_contributions'));
    await run('notifications', 'DELETE FROM notifications WHERE id = ANY($1::int[])', list('notifications'));
    await run('audit log entries', 'DELETE FROM audit_logs WHERE id = ANY($1::int[])', [...list('audit_logs'), Number(entry.id)]);
    await client.query(`UPDATE members SET share_capital = (SELECT COALESCE(SUM(amount), 0) FROM share_contributions WHERE member_id = $1) WHERE id = $1`, [Number(entry.entity_id)]);
  }
  return { removed, members: [...new Set(entries.map((entry) => Number(entry.entity_id)))] };
}
