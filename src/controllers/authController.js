import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query } from '../config/db.js';
import { buildAuthCookieOptions, digestToken, generateSecureToken, sanitizeUser } from '../utils/auth.js';
import { validatePasswordPolicy, hashPassword, verifyPassword } from '../utils/password.js';
import { createAuditLog } from '../utils/audit.js';
import { sendEmailSafely } from '../services/emailService.js';
import { passwordResetEmail } from '../services/emailTemplates.js';

function getRequestMeta(req) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

export async function login(req, res) {
  try {
    const { usernameOrEmail, password } = req.body || {};

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ message: 'Username/email and password are required.' });
    }

    const result = await query(
      `SELECT * FROM users
       WHERE username = LOWER($1)
          OR email = LOWER($1)`,
      [String(usernameOrEmail).trim()]
    );

    const user = result.rows[0];
    if (!user) {
      await createAuditLog({
        action: 'LOGIN_FAILURE',
        ...getRequestMeta(req),
        details: { usernameOrEmail: String(usernameOrEmail).trim(), reason: 'user_not_found' },
      });
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (user.account_status !== 'ACTIVE') {
      await createAuditLog({
        userId: user.id,
        action: 'LOGIN_FAILURE',
        ...getRequestMeta(req),
        details: { reason: `account_${user.account_status.toLowerCase()}` },
      });
      return res.status(403).json({ message: 'Your account is inactive or locked.' });
    }

    const isValidPassword = await verifyPassword(password, user.password_hash);
    if (!isValidPassword) {
      await createAuditLog({
        userId: user.id,
        action: 'LOGIN_FAILURE',
        ...getRequestMeta(req),
        details: { reason: 'invalid_password' },
      });
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const sessionToken = generateSecureToken(32);
    const sessionTokenHash = await bcrypt.hash(sessionToken, 12);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 8);

    await query(
      `INSERT INTO sessions (user_id, token_hash, token_digest, expires_at) VALUES ($1, $2, $3, $4)`,
      [user.id, sessionTokenHash, digestToken(sessionToken), expiresAt]
    );

    await query(
      `UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    res.cookie('session_token', sessionToken, buildAuthCookieOptions());

    await createAuditLog({
      user: { id: user.id, username: user.username, role: user.role, email: user.email },
      action: 'LOGIN',
      module: 'Authentication',
      entityType: 'user',
      entityId: String(user.id),
      description: `User ${user.username} logged in`,
      oldValues: {},
      newValues: { role: user.role, account_status: user.account_status },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });

    return res.status(200).json({
      message: 'Login successful.',
      user: sanitizeUser({ ...user, password_hash: undefined }),
      role: user.role,
      mustChangePassword: user.must_change_password,
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Unable to complete login.' });
  }
}

export async function logout(req, res) {
  try {
    const token = req.cookies?.session_token;
    const user = req.user || null;

    if (token && user) {
      const directResult = await query(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE user_id = $1 AND token_digest = $2 AND revoked_at IS NULL`,
        [user.user_id || user.id, digestToken(token)]
      );
      if (directResult.rowCount === 0) {
        const legacySessions = await query(`SELECT id, token_hash FROM sessions WHERE user_id = $1 AND token_digest IS NULL AND revoked_at IS NULL`, [user.user_id || user.id]);
        for (const session of legacySessions.rows) {
          if (await bcrypt.compare(token, session.token_hash)) {
            await query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1`, [session.id]);
            break;
          }
        }
      }
    }

    if (token && !user) {
      const directResult = await query(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE token_digest = $1 AND revoked_at IS NULL`,
        [digestToken(token)]
      );

      if (directResult.rowCount === 0) {
        const legacySessions = await query(
          `SELECT id, token_hash FROM sessions
           WHERE token_digest IS NULL AND revoked_at IS NULL
           ORDER BY created_at DESC`,
          []
        );
        for (const session of legacySessions.rows) {
          if (await bcrypt.compare(token, session.token_hash)) {
            await query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1`, [session.id]);
            break;
          }
        }
      }
    }

    res.clearCookie('session_token', buildAuthCookieOptions());

    if (user) {
      await createAuditLog({
        user: { id: user.user_id || user.id, username: user.username, role: user.role },
        action: 'LOGOUT',
        module: 'Authentication',
        entityType: 'user',
        entityId: String(user.user_id || user.id),
        description: `User ${user.username || 'unknown'} logged out`,
        oldValues: { active_session: true },
        newValues: { active_session: false },
        ...getRequestMeta(req),
        status: 'SUCCESS',
      });
    }

    return res.status(200).json({ message: 'Logged out successfully.' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ message: 'Unable to complete logout.' });
  }
}

export async function me(req, res) {
  const user = req.user;
  return res.status(200).json({
    user: sanitizeUser({
      id: user.user_id || user.id,
      member_id: user.member_id,
      username: user.username,
      email: user.email,
      role: user.role,
      account_status: user.account_status,
      must_change_password: user.must_change_password,
      last_login: user.last_login,
      password_changed_at: user.password_changed_at,
    })
  });
}

export async function forgotPassword(req, res) {
  try {
    const { usernameOrEmail } = req.body || {};
    if (!usernameOrEmail) {
      return res.status(400).json({ message: 'Email or username is required.' });
    }

    const userResult = await query(
      `SELECT * FROM users WHERE username = LOWER($1) OR email = LOWER($1)`,
      [String(usernameOrEmail).trim()]
    );

    if (!userResult.rows[0]) {
      return res.status(200).json({ message: 'If an account exists, reset instructions have been sent.' });
    }

    const user = userResult.rows[0];
    const token = generateSecureToken(24);
    const tokenHash = await bcrypt.hash(token, 12);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15);

    const resetTokenResult = await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`,
      [user.id, tokenHash, expiresAt]
    );

    await createAuditLog({
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      ...getRequestMeta(req),
      details: { expires_at: expiresAt.toISOString() },
    });

    if (user.email) {
      const email = passwordResetEmail({ username: user.username, token });
      void sendEmailSafely({ ...email, to: user.email, notificationType: 'password_reset', dedupeKey: String(resetTokenResult.rows[0].id), relatedUserId: user.id, relatedMemberId: user.member_id });
    }

    return res.status(200).json({
      message: 'If an account exists, reset instructions have been sent.',
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ message: 'Unable to process forgot-password request.' });
  }
}

export async function resetPassword(req, res) {
  try {
    const { token, newPassword, confirmPassword } = req.body || {};

    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'Token and new password are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }

    const policy = validatePasswordPolicy(newPassword);
    if (!policy.isValid) {
      return res.status(400).json({ message: policy.errors[0] });
    }

    const tokens = await query(
      `SELECT * FROM password_reset_tokens
       WHERE used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      []
    );

    let targetUser = null;
    let matchedToken = null;

    for (const row of tokens.rows) {
      const isMatch = await bcrypt.compare(token, row.token_hash);
      if (isMatch) {
        targetUser = row.user_id;
        matchedToken = row;
        break;
      }
    }

    if (!targetUser || !matchedToken) {
      return res.status(400).json({ message: 'Reset token is invalid or expired.' });
    }

    const userResult = await query(`SELECT * FROM users WHERE id = $1`, [targetUser]);
    const user = userResult.rows[0];
    const newHash = await hashPassword(newPassword);

    await query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [newHash, user.id]
    );

    await query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    await query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    );

    await createAuditLog({
      user: { id: user.id, username: user.username, role: user.role },
      action: 'PASSWORD_RESET_COMPLETED',
      module: 'Authentication',
      entityType: 'user',
      entityId: String(user.id),
      description: `Password reset completed for ${user.username}`,
      oldValues: { password_changed_at: user.password_changed_at },
      newValues: { password_changed_at: new Date().toISOString() },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });

    return res.status(200).json({ message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ message: 'Unable to reset password.' });
  }
}

export async function changePassword(req, res) {
  try {
    const userId = req.user.user_id || req.user.id;
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'New password must differ from the current password.' });
    }

    const policy = validatePasswordPolicy(newPassword);
    if (!policy.isValid) {
      return res.status(400).json({ message: policy.errors[0] });
    }

    const userResult = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const user = userResult.rows[0];

    const isCurrentPasswordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }

    const newHash = await hashPassword(newPassword);
    await query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [newHash, userId]
    );

    await query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    await createAuditLog({
      user: { id: userId, username: user.username, role: user.role },
      action: 'PASSWORD_CHANGED',
      module: 'Authentication',
      entityType: 'user',
      entityId: String(userId),
      description: `Password changed for ${user.username}`,
      oldValues: { password_changed_at: user.password_changed_at },
      newValues: { password_changed_at: new Date().toISOString() },
      ...getRequestMeta(req),
      status: 'SUCCESS',
    });

    return res.status(200).json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ message: 'Unable to change password.' });
  }
}
