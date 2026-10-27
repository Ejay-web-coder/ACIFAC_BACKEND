import { query, withTransaction } from '../config/db.js';
import { TIME_ZONE } from '../config/env.js';
import { hashPassword, validatePasswordPolicy } from '../utils/password.js';
import { createAuditLog } from '../utils/audit.js';
import { digestToken, generateSecureToken, sanitizeUser } from '../utils/auth.js';
import { isValidDateOnly } from '../utils/dates.js';
import { badRequest, cleanString, conflict, currentUserId, forbidden, getRequestMeta, notFound, paginationMeta, parseId, parsePagination } from '../utils/http.js';
import { sendEmailSafely, sendTestEmail } from '../services/emailService.js';
import { accountCreatedEmail, passwordResetEmail } from '../services/emailTemplates.js';
import { backfillAnnouncementNotifications, notifyUser } from '../services/notificationService.js';
import { findAccountsByEmail, findAccountsByPhone } from '../services/accountLookup.js';
import { maskPhilippineMobile, normalizePhilippineMobile } from '../utils/phone.js';

const ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE', 'LOCKED'];

export async function listMembersWithoutAccounts(req, res) {
  const result = await query(
    `SELECT m.id, m.member_number, m.first_name, m.last_name, m.email, m.phone
     FROM members m
     LEFT JOIN users u ON u.member_id = m.id
     WHERE u.id IS NULL AND m.status = 'active'
     ORDER BY m.last_name, m.first_name, m.id`,
    []
  );
  return res.status(200).json({ success: true, members: result.rows });
}

export async function listAccounts(req, res) {
  const result = await query(
    `SELECT m.id AS member_id, m.member_number, m.first_name, m.last_name, COALESCE(u.email, m.email) AS email, u.id AS user_id,
            COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS phone,
            u.username, u.role, u.account_status, u.must_change_password, u.last_login,
            u.created_at AS account_created_at, u.password_changed_at,
            -- An administrator's name and office, who made the account, and their latest action in the audit log.
            u.full_name, u.position, NULLIF(TRIM(COALESCE(cb.full_name, cb.username)), '') AS created_by_name,
            CASE WHEN u.role = 'ADMIN' THEN (SELECT MAX(al.created_at) FROM audit_logs al WHERE al.user_id = u.id) END AS last_activity_at
     FROM users u
     LEFT JOIN members m ON m.id = u.member_id
     LEFT JOIN users cb ON cb.id = u.created_by
     ORDER BY (u.role = 'ADMIN') DESC, u.created_at DESC`,
    []
  );
  return res.status(200).json({ success: true, accounts: result.rows });
}

export async function getAccount(req, res) {
  const id = parseId(req.params.id, 'account ID');
  const result = await query(
    `SELECT m.id AS member_id, m.member_number, m.first_name, m.last_name, COALESCE(u.email, m.email) AS email,
            u.id AS user_id, u.username, u.role, u.account_status, u.must_change_password,
            u.last_login, u.created_at AS account_created_at
     FROM users u
     LEFT JOIN members m ON m.id = u.member_id
     WHERE u.id = $1`,
    [id]
  );
  if (!result.rows[0]) throw notFound('Account not found.');
  return res.status(200).json({ success: true, account: result.rows[0] });
}

// A member signs in with the email and mobile number in their member
// information, so the office picks no username: one is made from the member
// number for the places that still show it (audit log, older sign-ins).
async function usernameFor(client, member) {
  const base = String(member.member_number || `member-${member.id}`).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || `member-${member.id}`;
  const taken = await client.query(`SELECT 1 FROM users WHERE LOWER(username) = $1`, [base]);
  return taken.rows[0] ? `${base}-${member.id}` : base;
}

const nameOf = (row) => row.member_name || row.full_name || row.username;

export async function createMemberAccount(req, res) {
  const { memberId, password, confirmPassword, role = 'MEMBER' } = req.body || {};
  const numericMemberId = parseId(memberId, 'member ID');
  if (!password || !confirmPassword) throw badRequest('Member and password are required.');
  if (password !== confirmPassword) throw badRequest('Passwords do not match.');
  if (role !== 'MEMBER') throw badRequest('Only MEMBER accounts can be created from the admin console.');
  const policy = validatePasswordPolicy(password);
  if (!policy.isValid) throw badRequest(policy.errors[0]);

  const passwordHash = await hashPassword(password);
  const setupToken = generateSecureToken(32);

  const { user, member, username, warnings } = await withTransaction(async (client) => {
    const memberResult = await client.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [numericMemberId]);
    const memberRow = memberResult.rows[0];
    if (!memberRow) throw notFound('Member record not found.');
    if (memberRow.status !== 'active') throw badRequest('Accounts can only be created for active members.');

    const existingUser = await client.query(`SELECT id FROM users WHERE member_id = $1`, [numericMemberId]);
    if (existingUser.rows[0]) throw conflict('A login account already exists for this member.');

    // The member signs in with the email and mobile number in their information.
    const email = memberRow.email?.trim() ? memberRow.email.trim().toLowerCase() : null;
    const phone = normalizePhilippineMobile(memberRow.phone);
    if (!email && !phone) throw badRequest('Add the member\'s email or mobile number in their member information first: they sign in with it.');
    if (email) {
      const emailInUse = await findAccountsByEmail(email, client);
      if (emailInUse.length) throw conflict(`Another account (${nameOf(emailInUse[0])}) already uses this member's email address.`);
    }
    // A shared number signs in to neither account, so it is only allowed when the member also has an email.
    const warnings = [];
    if (phone) {
      const phoneInUse = await findAccountsByPhone(phone, client);
      if (phoneInUse.length && !email) throw conflict(`Another account (${nameOf(phoneInUse[0])}) already uses this mobile number. Add the member's email first.`);
      if (phoneInUse.length) warnings.push(`${maskPhilippineMobile(phone)} is also on ${nameOf(phoneInUse[0])}'s account, so this member signs in with their email.`);
    }
    const username = await usernameFor(client, memberRow);

    const insertResult = await client.query(
      `INSERT INTO users (member_id, username, email, password_hash, role, account_status, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', TRUE, NOW(), NOW()) RETURNING *`,
      [numericMemberId, username, email, passwordHash, role]
    );
    const createdUser = insertResult.rows[0];
    await backfillAnnouncementNotifications(client, createdUser.id, createdUser.role);
    const digest = digestToken(setupToken);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, token_digest, expires_at) VALUES ($1, $2::text, $2::text, NOW() + INTERVAL '24 hours')`,
      [createdUser.id, digest]
    );
    await createAuditLog({
      client,
      user: req.user,
      action: 'ACCOUNT_CREATED',
      module: 'Accounts',
      entityType: 'user',
      entityId: String(createdUser.id),
      description: `Created account for member ${memberRow.member_number || numericMemberId}`,
      newValues: { username, role, member_id: numericMemberId, email, phone: memberRow.phone || null },
      targetUserId: createdUser.id,
      ...getRequestMeta(req),
    });
    await notifyUser(client, createdUser.id, {
      type: 'account_created',
      title: 'Welcome to ACIFAC',
      message: 'Your member account is ready. Please change your temporary password.',
      severity: 'success',
      link: '/settings',
      dedupeKey: `account-created-${createdUser.id}`,
    });
    return { user: createdUser, member: memberRow, username, warnings };
  });

  if (user.email) {
    const email = accountCreatedEmail({
      memberName: `${member.first_name || ''} ${member.last_name || ''}`.trim(), email: user.email,
      phone: warnings.length ? null : maskPhilippineMobile(member.phone), token: setupToken,
    });
    void sendEmailSafely({ ...email, to: user.email, relatedUserId: user.id, essential: true });
  }

  return res.status(201).json({ success: true, message: 'Member account created successfully.', user: sanitizeUser(user), username, warnings });
}

export async function sendEmailTest(req, res) {
  const recipient = cleanString(req.body?.recipient || req.user?.email || '', 255);
  if (!recipient) throw badRequest('A recipient email is required.');
  try {
    const result = await sendTestEmail(recipient);
    if (!result.sent) return res.status(503).json({ success: false, message: 'Email service is not configured.' });
    return res.status(200).json({ success: true, message: 'Email test sent successfully.' });
  } catch (error) {
    console.error('Email test error:', error instanceof Error ? error.message : error);
    return res.status(503).json({ success: false, message: 'Email service is unavailable.' });
  }
}

export async function updateAccountStatus(req, res) {
  const id = parseId(req.params.id, 'account ID');
  const status = req.body?.status;
  if (id === Number(currentUserId(req))) throw badRequest('You cannot change your own account status.');
  if (!ACCOUNT_STATUSES.includes(status)) throw badRequest('Status must be ACTIVE, INACTIVE, or LOCKED.');

  const account = await withTransaction(async (client) => {
    const before = await client.query(`SELECT id, username, role, account_status FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (!before.rows[0]) throw notFound('Account not found.');
    // The cooperative must always keep an administrator who can sign in.
    if (before.rows[0].role === 'ADMIN' && status !== 'ACTIVE') {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['admin-account-create']);
      const others = (await client.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' AND id <> $1`, [id])).rows[0].count;
      if (!others) throw badRequest('This is the only active administrator, so it cannot be switched off.');
    }
    const result = await client.query(`UPDATE users SET account_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [status, id]);
    let revokedSessions = 0;
    if (status !== 'ACTIVE') {
      // Deactivation ends every active session immediately; history is kept.
      const revoked = await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      revokedSessions = revoked.rowCount;
    }
    await createAuditLog({
      client,
      user: req.user,
      action: 'ACCOUNT_STATUS_UPDATED',
      module: 'Accounts',
      entityType: 'user',
      entityId: String(id),
      description: `Changed ${before.rows[0].username} from ${before.rows[0].account_status} to ${status}`,
      oldValues: { account_status: before.rows[0].account_status },
      newValues: { account_status: status, revoked_sessions: revokedSessions },
      targetUserId: id,
      ...getRequestMeta(req),
    });
    return result.rows[0];
  });

  return res.status(200).json({ success: true, message: 'Account status updated.', account: sanitizeUser(account) });
}

export async function resetMemberPassword(req, res) {
  const id = parseId(req.params.id, 'account ID');
  const resetToken = generateSecureToken(32);
  const unusablePasswordHash = await hashPassword(generateSecureToken(24));

  const targetUser = await withTransaction(async (client) => {
    const targetResult = await client.query(
      `SELECT u.*, TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) AS member_name FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = $1 FOR UPDATE OF u`,
      [id]
    );
    const target = targetResult.rows[0];
    if (!target) throw notFound('Account not found.');
    if (target.role !== 'MEMBER') throw forbidden('Only member passwords can be reset from the admin console.');
    if (!target.email) throw badRequest('This account has no email address, so a reset link cannot be delivered.');

    await client.query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [unusablePasswordHash, target.id]
    );
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [target.id]);
    const digest = digestToken(resetToken);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, token_digest, expires_at) VALUES ($1, $2::text, $2::text, NOW() + INTERVAL '24 hours')`,
      [target.id, digest]
    );
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
    await createAuditLog({
      client,
      user: req.user,
      action: 'PASSWORD_RESET_BY_ADMIN',
      module: 'Accounts',
      entityType: 'user',
      entityId: String(target.id),
      description: `Reset password for user ${target.username}`,
      oldValues: { must_change_password: target.must_change_password },
      newValues: { must_change_password: true },
      targetUserId: target.id,
      ...getRequestMeta(req),
    });
    return target;
  });

  const email = passwordResetEmail({ name: nameOf(targetUser), token: resetToken, expiresIn: '24 hours' });
  void sendEmailSafely({ ...email, to: targetUser.email, relatedUserId: targetUser.id, essential: true });
  if (process.env.NODE_ENV === 'test') res.setHeader('X-Test-Reset-Token', resetToken);
  return res.status(200).json({ success: true, message: 'Password reset instructions were sent to the member email address.' });
}

// Who did each action, by full name: the name kept with the entry, else (for
// entries older than that column) the person's current one.
const AUDIT_FROM_SQL = 'FROM audit_logs al LEFT JOIN users au ON au.id = al.user_id LEFT JOIN members am ON am.id = au.member_id';
const AUDIT_FULL_NAME_SQL = `COALESCE(al.user_full_name_snapshot, NULLIF(TRIM(CONCAT_WS(' ', am.first_name, am.last_name)), ''), NULLIF(TRIM(au.full_name), ''))`;
// The administrator's position when they acted; entries older than the snapshot show the current one.
const AUDIT_POSITION_SQL = `COALESCE(al.user_position_snapshot, CASE WHEN al.user_role_snapshot = 'ADMIN' THEN NULLIF(TRIM(au.position), '') END)`;

export async function listAuditLogs(req, res) {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25, maxLimit: 100 });
  const filters = {
    search: cleanString(req.query.search, 200),
    action: cleanString(req.query.action, 100),
    module: cleanString(req.query.module, 100),
    role: cleanString(req.query.role, 50),
    status: cleanString(req.query.status, 20),
    userId: cleanString(req.query.userId, 20),
    fromDate: cleanString(req.query.fromDate, 10),
    toDate: cleanString(req.query.toDate, 10),
  };

  const conditions = [];
  const params = [];
  const add = (sql, value) => { params.push(value); conditions.push(sql.replaceAll('$?', `$${params.length}`)); };

  if (filters.search) {
    add(`(COALESCE(al.user_name_snapshot, '') ILIKE $? OR COALESCE(${AUDIT_FULL_NAME_SQL}, '') ILIKE $? OR COALESCE(${AUDIT_POSITION_SQL}, '') ILIKE $? OR COALESCE(al.user_id::text, '') ILIKE $? OR COALESCE(al.entity_id, '') ILIKE $? OR COALESCE(al.description, '') ILIKE $?)`, `%${filters.search}%`);
  }
  if (filters.action) add('al.action = $?', filters.action);
  if (filters.module) add('al.module = $?', filters.module);
  if (filters.role) add('al.user_role_snapshot = $?', filters.role);
  if (filters.status) add('al.status = $?', filters.status);
  if (filters.userId) add('al.user_id = $?', parseId(filters.userId, 'user ID'));
  // Date filters are calendar days in the cooperative's time zone.
  if (filters.fromDate) {
    if (!isValidDateOnly(filters.fromDate)) throw badRequest('fromDate must be YYYY-MM-DD.');
    add(`al.created_at >= ($?::date::timestamp AT TIME ZONE '${TIME_ZONE}')`, filters.fromDate);
  }
  if (filters.toDate) {
    if (!isValidDateOnly(filters.toDate)) throw badRequest('toDate must be YYYY-MM-DD.');
    add(`al.created_at < (($?::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')`, filters.toDate);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [totalResult, logsResult] = await Promise.all([
    query(`SELECT COUNT(*)::int AS total ${AUDIT_FROM_SQL} ${whereClause}`, params),
    query(
      `SELECT al.id, al.user_id, al.user_name_snapshot, al.user_role_snapshot, ${AUDIT_FULL_NAME_SQL} AS user_full_name, ${AUDIT_POSITION_SQL} AS user_position,
              al.action, al.module, al.entity_type, al.entity_id, al.description, al.old_values, al.new_values,
              al.target_user_id, al.ip_address, al.status, al.created_at
       ${AUDIT_FROM_SQL}
       ${whereClause}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);

  return res.status(200).json({ success: true, data: logsResult.rows, pagination: paginationMeta(page, limit, totalResult.rows[0].total) });
}
