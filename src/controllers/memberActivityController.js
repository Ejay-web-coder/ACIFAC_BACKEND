import { query } from '../config/db.js';
import { TIME_ZONE } from '../config/env.js';
import { isValidDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, currentUserId, notFound, paginationMeta, parsePagination } from '../utils/http.js';

// A member's own activity log: everything they did from their account, plus
// what the ACIFAC office did on their records (savings, loans, rentals...).
// Office entries never reveal which administrator acted or from where.

const ACTIONS = {
  // Sign-in & security
  LOGIN: ['security', 'Signed in'],
  LOGOUT: ['security', 'Signed out'],
  LOGIN_FAILURE: ['security', 'Failed sign-in attempt'],
  LOGIN_LOCKED: ['security', 'Sign-in locked after failed attempts'],
  LOGIN_BLOCKED: ['security', 'Sign-in attempt while locked'],
  SESSION_EXPIRED: ['security', 'Signed out after inactivity'],
  PASSWORD_CHANGED: ['security', 'Password changed'],
  PASSWORD_RESET_REQUESTED: ['security', 'Password reset requested'],
  PASSWORD_RESET_CODE_SENT: ['security', 'Password reset code emailed'],
  PASSWORD_RESET_CODE_FAILED: ['security', 'Incorrect password reset code'],
  PASSWORD_RESET_CODE_VERIFIED: ['security', 'Password reset code verified'],
  PASSWORD_RESET_COMPLETED: ['security', 'Password reset'],
  PASSWORD_RESET_BY_ADMIN: ['security', 'Password reset by the office'],
  ACCOUNT_CREATED: ['security', 'Login account created'],
  ACCOUNT_STATUS_UPDATED: ['security', 'Account status changed'],
  // Profile & membership
  PROFILE_UPDATED: ['profile', 'Profile information updated'],
  PROFILE_PHOTO_UPDATED: ['profile', 'Profile picture changed'],
  PROFILE_PHOTO_REMOVED: ['profile', 'Profile picture removed'],
  NOTIFICATION_PREFERENCES_UPDATED: ['profile', 'Notification settings changed'],
  MEMBER_CREATED: ['profile', 'Membership registered'],
  MEMBER_UPDATED: ['profile', 'Member record updated'],
  MEMBER_ARCHIVED: ['profile', 'Membership archived'],
  MEMBER_RESTORED: ['profile', 'Membership restored'],
  // Savings & share capital
  SAVINGS_DEPOSIT_CREATED: ['savings', 'Savings deposit recorded'],
  SHARE_CONTRIBUTION_CREATED: ['savings', 'Share capital contribution recorded'],
  // Loans & payments
  LOAN_APPLICATION_SUBMITTED: ['loans', 'Loan application submitted'],
  LOAN_APPROVED: ['loans', 'Loan application approved'],
  LOAN_REJECTED: ['loans', 'Loan application declined'],
  LOAN_CREATED: ['loans', 'Loan released'],
  PAYMENT_CREATED: ['loans', 'Loan payment recorded'],
  // Machinery rentals
  RENTAL_REQUESTED: ['machinery', 'Machinery rental requested'],
  RENTAL_APPROVED: ['machinery', 'Machinery rental approved'],
  RENTAL_DECLINED: ['machinery', 'Machinery rental declined'],
  OPERATION_COMPLETED: ['machinery', 'Machinery rental completed'],
};

export const ACTIVITY_CATEGORIES = {
  security: 'Sign-in & security',
  profile: 'Profile & membership',
  savings: 'Savings & share capital',
  loans: 'Loans & payments',
  machinery: 'Machinery rentals',
};

const actionsIn = (category) => Object.entries(ACTIONS).filter(([, [group]]) => group === category).map(([action]) => action);

// Friendly names for the fields shown in "what changed" (values are not shown
// for office edits, only which details changed).
const FIELD_NAMES = {
  full_name: 'name', first_name: 'first name', middle_name: 'middle name', last_name: 'last name', email: 'email', phone: 'phone number',
  address: 'address', barangay: 'barangay', municipality: 'municipality', province: 'province', date_of_birth: 'birthday', gender: 'gender',
  civil_status: 'civil status', education: 'education', id_type: 'ID type', id_number: 'ID number', rsbsa_no: 'RSBSA number',
  livelihood: 'livelihood', farm_area_ha: 'farm area', yearly_income: 'annual income', spouse_name: 'spouse', spouse_age: 'spouse age',
  spouse_contact: 'spouse contact', children: 'children', membership_date: 'membership date', status: 'status', additional_info: 'membership details',
  position: 'position', emailNotifications: 'email notifications', smsNotifications: 'SMS notifications', loanReminders: 'loan reminders',
};

function changedFields(oldValues, newValues) {
  const before = oldValues && typeof oldValues === 'object' ? oldValues : {};
  const after = newValues && typeof newValues === 'object' ? newValues : {};
  return Object.keys(FIELD_NAMES).filter((key) => key in after && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)).map((key) => FIELD_NAMES[key]);
}

// "Chrome on Windows" from a browser's user agent string.
export function describeDevice(userAgent) {
  const agent = String(userAgent || '');
  if (!agent) return null;
  const browser = /Edg\//.test(agent) ? 'Edge' : /SamsungBrowser/.test(agent) ? 'Samsung Internet' : /OPR\/|Opera/.test(agent) ? 'Opera'
    : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const system = /Android/.test(agent) ? 'Android' : /iPhone|iPad|iPod/.test(agent) ? 'iPhone/iPad' : /Windows/.test(agent) ? 'Windows'
    : /Mac OS X/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : 'unknown device';
  return `${browser} on ${system}`;
}

// Audit entries that concern this member: their own account's actions, and
// office actions on their member record, savings, loans and rentals.
const SCOPE = `
  SELECT id FROM audit_logs WHERE user_id = $1::bigint OR target_user_id = $1::bigint OR (entity_type = 'user' AND entity_id = $1::bigint::text)
  UNION SELECT id FROM audit_logs WHERE entity_type = 'member' AND entity_id = $2::bigint::text
  UNION SELECT al.id FROM audit_logs al JOIN savings_transactions x ON al.entity_type = 'savings_transaction' AND al.entity_id = x.id::text WHERE x.member_id = $2::bigint
  UNION SELECT al.id FROM audit_logs al JOIN share_contributions x ON al.entity_type = 'share_contribution' AND al.entity_id = x.id::text WHERE x.member_id = $2::bigint
  UNION SELECT al.id FROM audit_logs al JOIN loan_requests x ON al.entity_type = 'loan_request' AND al.entity_id = x.id::text WHERE x.member_id = $2::bigint
  UNION SELECT al.id FROM audit_logs al JOIN loans x ON al.entity_type = 'loan' AND al.entity_id = x.id::text WHERE x.member_id = $2::bigint
  UNION SELECT al.id FROM audit_logs al JOIN loan_payments p ON al.entity_type = 'loan_payment' AND al.entity_id = p.id::text JOIN loans l ON l.id = p.loan_id WHERE l.member_id = $2::bigint
  UNION SELECT al.id FROM audit_logs al JOIN rental_requests x ON al.entity_type = 'rental_request' AND al.entity_id = x.id::text WHERE x.member_id = $2::bigint
  UNION SELECT al.id FROM audit_logs al JOIN machinery_operations x ON al.entity_type = 'machinery_operation' AND al.entity_id = x.id::text WHERE x.member_id = $2::bigint`;

// GET /api/members/me/activity?category=&actor=me|office&status=SUCCESS|FAILED&fromDate=&toDate=&search=&page=&limit=
export async function getMyActivity(req, res) {
  const userId = Number(currentUserId(req));
  const memberId = Number(req.user?.member_id);
  if (!Number.isInteger(memberId) || memberId <= 0) throw notFound('No member record is linked to this account.');
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 50 });

  const params = [userId, memberId];
  const conditions = [`al.action = ANY($3::text[])`];
  params.push(Object.keys(ACTIONS));
  const add = (sql, value) => { params.push(value); conditions.push(sql.replaceAll('$?', `$${params.length}`)); };

  const category = cleanString(req.query.category, 20);
  if (category) {
    if (!ACTIVITY_CATEGORIES[category]) throw badRequest('Unknown activity category.');
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
    // Matches the description or the friendly action name.
    const labelMatches = Object.entries(ACTIONS).filter(([, [, label]]) => label.toLowerCase().includes(search.toLowerCase())).map(([action]) => action);
    params.push(`%${search}%`);
    const textParam = params.length;
    params.push(labelMatches);
    conditions.push(`(al.description ILIKE $${textParam} OR al.action = ANY($${params.length}::text[]))`);
  }

  const where = `al.id IN (${SCOPE}) AND ${conditions.join(' AND ')}`;
  const [rows, count, summary] = await Promise.all([
    query(
      `SELECT al.id, al.created_at, al.action, al.user_id, al.status, al.description, al.ip_address, al.user_agent, al.old_values, al.new_values
       FROM audit_logs al WHERE ${where}
       ORDER BY al.created_at DESC, al.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*)::int AS total FROM audit_logs al WHERE ${where}`, params),
    query(
      `SELECT MAX(created_at) FILTER (WHERE action = 'LOGIN') AS "lastSignIn",
              COUNT(*) FILTER (WHERE action = 'LOGIN_FAILURE' AND created_at > NOW() - INTERVAL '30 days')::int AS "failedSignIns30Days"
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
      status: row.status === 'FAILED' ? 'failed' : 'success',
      description: row.description || '',
      changes: ['PROFILE_UPDATED', 'MEMBER_UPDATED', 'NOTIFICATION_PREFERENCES_UPDATED'].includes(row.action) ? changedFields(row.old_values, row.new_values) : [],
      // Where the member signed in from; never shown for office actions.
      device: mine ? describeDevice(row.user_agent) : null,
      ipAddress: mine ? row.ip_address || null : null,
    };
  });

  return res.json({
    success: true,
    data,
    pagination: paginationMeta(page, limit, count.rows[0].total),
    summary: summary.rows[0],
    categories: ACTIVITY_CATEGORIES,
  });
}
