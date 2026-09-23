import { query } from '../config/db.js';

// Persistent in-app notifications. `db` is either a transaction client or the
// pool-level query helper, so notifications commit together with the change
// that caused them. dedupe_key prevents the same event notifying twice.

function runner(db) {
  return db && typeof db.query === 'function' ? db.query.bind(db) : query;
}

export async function createNotifications(db, userIds, notification) {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return 0;
  const { type, title, message = '', severity = 'info', link = null, entityType = null, entityId = null, dedupeKey = null } = notification;
  const result = await runner(db)(
    `INSERT INTO notifications (user_id, type, title, message, severity, link, entity_type, entity_id, dedupe_key)
     SELECT unnest($1::int[]), $2, $3, $4, $5, $6, $7, $8, $9
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [ids, type, String(title).slice(0, 200), message, severity, link, entityType, entityId === null ? null : String(entityId), dedupeKey]
  );
  return result.rowCount;
}

export async function notifyAdmins(db, notification, { exceptUserId = null } = {}) {
  const admins = await runner(db)(
    `SELECT id FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' AND ($1::int IS NULL OR id <> $1)`,
    [exceptUserId]
  );
  return createNotifications(db, admins.rows.map((row) => row.id), notification);
}

export async function notifyMember(db, memberId, notification) {
  if (!memberId) return 0;
  const users = await runner(db)(
    `SELECT id FROM users WHERE member_id = $1 AND account_status = 'ACTIVE'`,
    [memberId]
  );
  return createNotifications(db, users.rows.map((row) => row.id), notification);
}

export async function notifyUser(db, userId, notification) {
  return createNotifications(db, [userId], notification);
}
