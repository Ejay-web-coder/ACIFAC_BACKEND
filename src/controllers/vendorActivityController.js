import { query } from '../config/db.js';
import { TIME_ZONE } from '../config/env.js';
import { isValidDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, currentUserId, paginationMeta, parsePagination } from '../utils/http.js';
import { describeDevice } from './memberActivityController.js';

// A Kadiwa vendor's own activity log: their sign-ins, the sales they sent, and
// what the office did on their account and sales (confirmed, rejected, renamed,
// new password). Same shape as the member's activity log.

const ACTIONS = {
  LOGIN: ['security', 'Signed in'],
  LOGOUT: ['security', 'Signed out'],
  LOGIN_FAILURE: ['security', 'Failed sign-in attempt'],
  LOGIN_LOCKED: ['security', 'Sign-in locked after failed attempts'],
  LOGIN_BLOCKED: ['security', 'Sign-in attempt while locked'],
  VENDOR_ACCOUNT_CREATED: ['security', 'Vendor account created'],
  VENDOR_ACCOUNT_UPDATED: ['security', 'Account details changed'],
  VENDOR_PASSWORD_CHANGED: ['security', 'New password set by the office'],
  KADIWA_SALE_SUBMITTED: ['sales', 'Sale sent for review'],
  KADIWA_SALE_CONFIRMED: ['sales', 'Sale confirmed'],
  KADIWA_SALE_REJECTED: ['sales', 'Sale rejected'],
};
export const VENDOR_ACTIVITY_CATEGORIES = { security: 'Sign-in & account', sales: 'Sales' };
const actionsIn = (category) => Object.entries(ACTIONS).filter(([, [group]]) => group === category).map(([action]) => action);

// Plain words for the vendor; the administrator's name is never shown.
function describe(row, mine, username) {
  const sale = row.entity_id;
  switch (row.action) {
    case 'LOGIN': return username ? `You signed in as ${username}.` : 'You signed in.';
    case 'LOGOUT': return 'You signed out.';
    case 'LOGIN_FAILURE': return 'Someone tried to sign in to your account with a wrong password.';
    case 'LOGIN_LOCKED': return 'Too many wrong passwords, so signing in was locked for a while.';
    case 'VENDOR_ACCOUNT_CREATED': return 'The office made your vendor account.';
    case 'VENDOR_ACCOUNT_UPDATED': return 'The office changed your account details (name or branch).';
    case 'VENDOR_PASSWORD_CHANGED': return 'The office set a new password for your account.';
    case 'KADIWA_SALE_SUBMITTED': return `You sent sale ${sale} for the office to confirm.`;
    case 'KADIWA_SALE_CONFIRMED': return `The office confirmed your sale ${sale}.${row.new_values?.notes ? ` Note: ${row.new_values.notes}` : ''}`;
    case 'KADIWA_SALE_REJECTED': return `The office rejected your sale ${sale}${row.new_values?.reason ? `: ${row.new_values.reason}` : '.'}`;
    default: return row.description || '';
  }
}
const amountOf = (row) => {
  const value = row.new_values?.total_sales ?? null;
  return value === null || value === undefined ? null : Number(value);
};

// GET /api/vendor/activity?category=security|sales&actor=me|office&status=SUCCESS|FAILED&fromDate=&toDate=&search=&page=&limit=
export async function getVendorActivity(req, res) {
  const userId = Number(currentUserId(req));
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 50 });
  const params = [userId, Object.keys(ACTIONS)];
  const conditions = ['(al.user_id = $1::bigint OR al.target_user_id = $1::bigint)', 'al.action = ANY($2::text[])'];
  const add = (sql, value) => { params.push(value); conditions.push(sql.replaceAll('$?', `$${params.length}`)); };

  const category = cleanString(req.query.category, 20);
  if (category) {
    if (!VENDOR_ACTIVITY_CATEGORIES[category]) throw badRequest('Unknown activity category.');
    add('al.action = ANY($?::text[])', actionsIn(category));
  }
  const actor = cleanString(req.query.actor, 10);
  if (actor === 'me') conditions.push('al.user_id = $1::bigint');
  else if (actor === 'office') conditions.push('al.user_id IS DISTINCT FROM $1::bigint');
  const status = cleanString(req.query.status, 10).toUpperCase();
  if (status === 'SUCCESS' || status === 'FAILED') add('al.status = $?', status);
  const fromDate = cleanString(req.query.fromDate, 10);
  const toDate = cleanString(req.query.toDate, 10);
  if (fromDate) {
    if (!isValidDateOnly(fromDate)) throw badRequest('The start date must be a valid date.');
    add(`al.created_at >= ($?::date::timestamp AT TIME ZONE '${TIME_ZONE}')`, fromDate);
  }
  if (toDate) {
    if (!isValidDateOnly(toDate)) throw badRequest('The end date must be a valid date.');
    add(`al.created_at < (($?::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')`, toDate);
  }
  const search = cleanString(req.query.search, 100);
  if (search) {
    const labelMatches = Object.entries(ACTIONS).filter(([, [, label]]) => label.toLowerCase().includes(search.toLowerCase())).map(([action]) => action);
    params.push(`%${search}%`);
    const textParam = params.length;
    params.push(labelMatches);
    conditions.push(`(al.description ILIKE $${textParam} OR al.entity_id ILIKE $${textParam} OR al.action = ANY($${params.length}::text[]))`);
  }

  const where = conditions.join(' AND ');
  const [rows, count, summary] = await Promise.all([
    query(
      `SELECT al.id, al.created_at, al.action, al.user_id, al.status, al.description, al.entity_id, al.ip_address, al.user_agent, al.new_values
       FROM audit_logs al WHERE ${where}
       ORDER BY al.created_at DESC, al.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM audit_logs al WHERE ${where}`, params),
    query(
      `SELECT MAX(created_at) FILTER (WHERE action = 'LOGIN') AS "lastSignIn",
              COUNT(*) FILTER (WHERE action = 'LOGIN_FAILURE' AND created_at > NOW() - INTERVAL '30 days')::int AS "failedSignIns30Days",
              (SELECT user_agent FROM audit_logs WHERE user_id = $1::bigint AND action = 'LOGIN' ORDER BY created_at DESC, id DESC LIMIT 1) AS "lastSignInAgent"
       FROM audit_logs WHERE user_id = $1::bigint`,
      [userId]
    ),
  ]);

  const data = rows.rows.map((row) => {
    const mine = Number(row.user_id) === userId;
    const [categoryKey, label] = ACTIONS[row.action];
    return {
      id: Number(row.id),
      at: row.created_at,
      action: row.action,
      label,
      category: categoryKey,
      actor: mine ? 'you' : 'office',
      // A rejected sale is shown as needing attention.
      status: row.status === 'FAILED' || row.action === 'KADIWA_SALE_REJECTED' ? 'failed' : 'success',
      description: describe(row, mine, req.user?.username),
      amount: amountOf(row),
      changes: [],
      device: mine ? describeDevice(row.user_agent) : null,
      ipAddress: mine ? row.ip_address || null : null,
    };
  });
  return res.json({
    success: true,
    data,
    pagination: paginationMeta(page, limit, count.rows[0].total),
    summary: { lastSignIn: summary.rows[0].lastSignIn, lastSignInDevice: describeDevice(summary.rows[0].lastSignInAgent), failedSignIns30Days: summary.rows[0].failedSignIns30Days },
    categories: VENDOR_ACTIVITY_CATEGORIES,
  });
}
