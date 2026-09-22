import { query } from '../config/db.js';
import { hashPassword, validatePasswordPolicy } from '../utils/password.js';
import { createAuditLog } from '../utils/audit.js';
import { sanitizeUser } from '../utils/auth.js';
import { generateSecureToken } from '../utils/auth.js';
import { sendEmailSafely, sendTestEmail } from '../services/emailService.js';
import { accountCreatedEmail, passwordResetEmail } from '../services/emailTemplates.js';

function getRequestMeta(req) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

export async function listMembersWithoutAccounts(req, res) {
  try {
    const result = await query(
      `SELECT m.id, m.member_number, m.first_name, m.last_name, m.email
       FROM members m
       LEFT JOIN users u ON u.member_id = m.id
       WHERE u.id IS NULL
       ORDER BY m.last_name, m.first_name, m.id`,
      []
    );

    return res.status(200).json({ members: result.rows });
  } catch (error) {
    console.error('List available members error:', error);
    return res.status(500).json({ message: 'Unable to list available members.' });
  }
}

export async function listAccounts(req, res) {
  try {
    const result = await query(
      `SELECT m.id AS member_id, m.member_number, m.first_name, m.last_name, m.email, u.id AS user_id,
              u.username, u.role, u.account_status, u.must_change_password, u.last_login,
              u.created_at AS account_created_at, u.password_changed_at
       FROM users u
       LEFT JOIN members m ON m.id = u.member_id
       ORDER BY u.created_at DESC`,
      []
    );

    return res.status(200).json({ accounts: result.rows });
  } catch (error) {
    console.error('List accounts error:', error);
    return res.status(500).json({ message: 'Unable to list accounts.' });
  }
}

export async function getAccount(req, res) {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT m.id AS member_id, m.member_number, m.first_name, m.last_name, m.email,
              u.id AS user_id, u.username, u.role, u.account_status, u.must_change_password,
              u.last_login, u.created_at AS account_created_at
       FROM users u
       LEFT JOIN members m ON m.id = u.member_id
       WHERE u.id = $1`,
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Account not found.' });
    }

    return res.status(200).json({ account: result.rows[0] });
  } catch (error) {
    console.error('Get account error:', error);
    return res.status(500).json({ message: 'Unable to fetch account.' });
  }
}

export async function createMemberAccount(req, res) {
  try {
    const { memberId, username: rawUsername, password, confirmPassword, role = 'MEMBER' } = req.body || {};
    const username = String(rawUsername || '').trim().toLowerCase();
    const numericMemberId = Number(memberId);

    if (!Number.isInteger(numericMemberId) || numericMemberId <= 0 || !username || !password || !confirmPassword) {
      return res.status(400).json({ message: 'Member ID, username, and password are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }

    if (role !== 'MEMBER') {
      return res.status(400).json({ message: 'Only MEMBER accounts can be created from the admin console.' });
    }

    const memberResult = await query(`SELECT * FROM members WHERE id = $1`, [numericMemberId]);
    if (!memberResult.rows[0]) {
      return res.status(404).json({ message: 'Member record not found.' });
    }

    const existingUser = await query(`SELECT * FROM users WHERE member_id = $1 OR username = $2`, [numericMemberId, username]);
    if (existingUser.rows[0]) {
      return res.status(409).json({ message: 'A login account already exists for this member or username.' });
    }

    const policy = validatePasswordPolicy(password);
    if (!policy.isValid) {
      return res.status(400).json({ message: policy.errors[0] });
    }

    const passwordHash = await hashPassword(password);
    const insertResult = await query(
      `INSERT INTO users (member_id, username, email, password_hash, role, account_status, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', TRUE, NOW(), NOW()) RETURNING *`,
      [numericMemberId, username, memberResult.rows[0].email, passwordHash, role]
    );

    const setupToken = generateSecureToken(24);
    const setupTokenHash = await hashPassword(setupToken);
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [insertResult.rows[0].id, setupTokenHash]
    );
    if (memberResult.rows[0].email) {
      const email = accountCreatedEmail({ memberName: `${memberResult.rows[0].first_name} ${memberResult.rows[0].last_name}`.trim(), username, token: setupToken });
      void sendEmailSafely({ ...email, to: memberResult.rows[0].email, notificationType: 'account_created', dedupeKey: String(insertResult.rows[0].id), relatedUserId: insertResult.rows[0].id, relatedMemberId: numericMemberId });
    }

    await createAuditLog({
      user: req.user,
      action: 'ACCOUNT_CREATED',
      module: 'Accounts',
      entityType: 'user',
      entityId: String(insertResult.rows[0].id),
      description: `Created account for member ${memberResult.rows[0].member_number || numericMemberId}`,
      oldValues: {},
      newValues: { username, role, member_id: numericMemberId },
      targetUserId: insertResult.rows[0].id,
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });

    return res.status(201).json({
      message: 'Member account created successfully.',
      user: sanitizeUser(insertResult.rows[0]),
    });
  } catch (error) {
    console.error('Create member account error:', error);
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'A login account already exists for this member or username.' });
    }
    return res.status(500).json({ message: 'Unable to create member account.' });
  }
}

export async function sendEmailTest(req, res) {
  try {
    const recipient = String(req.body?.recipient || req.user?.email || '').trim();
    if (!recipient) return res.status(400).json({ message: 'A recipient email is required.' });
    const result = await sendTestEmail(recipient);
    if (!result.sent) return res.status(503).json({ message: 'Email test could not be sent.' });
    return res.status(200).json({ message: 'Email test sent successfully.' });
  } catch (error) {
    console.error('Email test error:', error instanceof Error ? error.message : error);
    return res.status(503).json({ message: 'Email service is unavailable.' });
  }
}

export async function updateAccountStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (Number(id) === Number(req.user.user_id || req.user.id)) {
      return res.status(400).json({ message: 'You cannot change your own account status.' });
    }

    if (!['ACTIVE', 'INACTIVE', 'LOCKED'].includes(status)) {
      return res.status(400).json({ message: 'Status must be ACTIVE, INACTIVE, or LOCKED.' });
    }

    const result = await query(
      `UPDATE users SET account_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Account not found.' });
    }

    await createAuditLog({
      user: req.user,
      action: 'ACCOUNT_STATUS_UPDATED',
      module: 'Accounts',
      entityType: 'user',
      entityId: String(result.rows[0].id),
      description: `Updated account status to ${status}`,
      oldValues: { account_status: result.rows[0].account_status },
      newValues: { account_status: status },
      targetUserId: result.rows[0].id,
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });

    return res.status(200).json({ message: 'Account status updated.', account: sanitizeUser(result.rows[0]) });
  } catch (error) {
    console.error('Update account status error:', error);
    return res.status(500).json({ message: 'Unable to update account status.' });
  }
}

export async function resetMemberPassword(req, res) {
  try {
    const { id } = req.params;
    const targetUserResult = await query(`SELECT * FROM users WHERE id = $1`, [id]);
    const targetUser = targetUserResult.rows[0];

    if (!targetUser) {
      return res.status(404).json({ message: 'Account not found.' });
    }

    if (targetUser.role !== 'MEMBER') {
      return res.status(403).json({ message: 'Only member passwords can be reset from the admin console.' });
    }

    const resetToken = generateSecureToken(24);
    const passwordHash = await hashPassword(generateSecureToken(24));

    await query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [passwordHash, targetUser.id]
    );

    const tokenHash = await hashPassword(resetToken);
    const tokenResult = await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes') RETURNING id`,
      [targetUser.id, tokenHash]
    );
    if (targetUser.email) {
      const email = passwordResetEmail({ username: targetUser.username, token: resetToken });
      void sendEmailSafely({ ...email, to: targetUser.email, notificationType: 'admin_password_reset', dedupeKey: String(tokenResult.rows[0].id), relatedUserId: targetUser.id, relatedMemberId: targetUser.member_id });
    }

    await query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [targetUser.id]
    );

    await createAuditLog({
      user: req.user,
      action: 'PASSWORD_RESET_COMPLETED',
      module: 'Accounts',
      entityType: 'user',
      entityId: String(targetUser.id),
      description: `Reset password for user ${targetUser.username}`,
      oldValues: { password_changed_at: targetUser.password_changed_at },
      newValues: { password_changed_at: new Date().toISOString(), must_change_password: true },
      targetUserId: targetUser.id,
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Password reset instructions sent to the member email address.',
    });
  } catch (error) {
    console.error('Reset member password error:', error);
    return res.status(500).json({ message: 'Unable to reset member password.' });
  }
}

export async function listAuditLogs(req, res) {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const action = String(req.query.action || '').trim();
    const module = String(req.query.module || '').trim();
    const role = String(req.query.role || '').trim();
    const status = String(req.query.status || '').trim();
    const userId = String(req.query.userId || '').trim();
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate = String(req.query.toDate || '').trim();

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push(`(
        COALESCE(al.user_name_snapshot, '') ILIKE $${params.length + 1}
        OR COALESCE(al.user_id::text, '') ILIKE $${params.length + 1}
        OR COALESCE(al.entity_id::text, '') ILIKE $${params.length + 1}
        OR COALESCE(al.description, '') ILIKE $${params.length + 1}
      )`);
      params.push(`%${search}%`);
    }

    if (action) {
      conditions.push(`al.action = $${params.length + 1}`);
      params.push(action);
    }

    if (module) {
      conditions.push(`al.module = $${params.length + 1}`);
      params.push(module);
    }

    if (role) {
      conditions.push(`al.user_role_snapshot = $${params.length + 1}`);
      params.push(role);
    }

    if (status) {
      conditions.push(`al.status = $${params.length + 1}`);
      params.push(status);
    }

    if (userId) {
      conditions.push(`al.user_id = $${params.length + 1}`);
      params.push(Number(userId));
    }

    if (fromDate) {
      conditions.push(`al.created_at >= $${params.length + 1}`);
      params.push(new Date(`${fromDate}T00:00:00`));
    }

    if (toDate) {
      conditions.push(`al.created_at < $${params.length + 1}`);
      params.push(new Date(`${toDate}T23:59:59.999Z`));
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countQuery = `SELECT COUNT(*)::int AS total FROM audit_logs al ${whereClause}`;
    const logsQuery = `
      SELECT al.id, al.user_id, al.user_name_snapshot, al.user_role_snapshot, al.action, al.module,
             al.entity_type, al.entity_id, al.description, al.old_values, al.new_values,
             al.target_user_id, al.ip_address, al.user_agent, al.status, al.created_at
      FROM audit_logs al
      ${whereClause}
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const totalResult = await query(countQuery, params);
    const logsResult = await query(logsQuery, [...params, limit, offset]);

    return res.status(200).json({
      success: true,
      data: logsResult.rows,
      pagination: {
        page,
        limit,
        total: totalResult.rows[0].total,
        totalPages: Math.ceil(totalResult.rows[0].total / limit),
      },
    });
  } catch (error) {
    console.error('List audit logs error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load audit logs.' });
  }
}
