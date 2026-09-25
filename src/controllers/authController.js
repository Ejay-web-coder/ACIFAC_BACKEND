import { query, withTransaction } from '../config/db.js';
import { buildAuthCookieOptions, digestToken, generateSecureToken, sanitizeUser, SESSION_TTL_MS } from '../utils/auth.js';
import { validatePasswordPolicy, hashPassword, verifyPassword } from '../utils/password.js';
import { createAuditLog } from '../utils/audit.js';
import { badRequest, cleanString, currentUserId, getRequestMeta, optionalString } from '../utils/http.js';
import { sendEmailSafely } from '../services/emailService.js';
import { passwordResetEmail } from '../services/emailTemplates.js';
import { notifyUser } from '../services/notificationService.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;
// Used to spend the same bcrypt time when the user does not exist.
let dummyHashPromise = null;
const getDummyHash = () => (dummyHashPromise ??= hashPassword(generateSecureToken(16)));

// Members sign in with their username or member number; email sign-in is kept
// for administrators only.
async function findUserByIdentifier(identifier) {
  const result = await query(
    `SELECT u.* FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE LOWER(u.username) = LOWER($1)
        OR (u.role = 'MEMBER' AND LOWER(m.member_number) = LOWER($1))
        OR (u.role = 'ADMIN' AND LOWER(u.email) = LOWER($1))
     ORDER BY (LOWER(u.username) = LOWER($1)) DESC LIMIT 1`,
    [identifier]
  );
  return result.rows[0] || null;
}

function publicUser(row) {
  return sanitizeUser({
    id: row.user_id ?? row.id,
    member_id: row.member_id,
    username: row.username,
    email: row.email,
    role: row.role,
    account_status: row.account_status,
    must_change_password: row.must_change_password,
    last_login: row.last_login,
    password_changed_at: row.password_changed_at,
    full_name: row.full_name ?? null,
  });
}

export async function login(req, res) {
  const identifier = cleanString(req.body?.usernameOrEmail, 255);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!identifier || !password) throw badRequest('Username/email and password are required.');

  const user = await findUserByIdentifier(identifier);
  const isValidPassword = await verifyPassword(password, user?.password_hash || await getDummyHash());

  if (!user || !isValidPassword) {
    await createAuditLog({
      userId: user?.id ?? null,
      action: 'LOGIN_FAILURE',
      module: 'Authentication',
      entityType: 'user',
      entityId: user ? String(user.id) : null,
      description: 'Failed sign-in attempt',
      ...getRequestMeta(req),
      status: 'FAILED',
      details: { identifier, reason: user ? 'invalid_password' : 'user_not_found' },
    });
    return res.status(401).json({ success: false, message: 'Invalid credentials.' });
  }

  // Status is only revealed after a correct password, so it cannot be used to
  // discover which accounts exist.
  if (user.account_status !== 'ACTIVE') {
    await createAuditLog({ userId: user.id, action: 'LOGIN_FAILURE', module: 'Authentication', entityType: 'user', entityId: String(user.id), ...getRequestMeta(req), status: 'FAILED', details: { reason: `account_${user.account_status.toLowerCase()}` } });
    return res.status(403).json({ success: false, message: 'Your account is inactive or locked. Please contact the ACIFAC office.' });
  }

  const sessionToken = generateSecureToken(32);
  const digest = digestToken(sessionToken);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO sessions (user_id, token_hash, token_digest, expires_at) VALUES ($1, $2::text, $2::text, $3)`,
      [user.id, digest, new Date(Date.now() + SESSION_TTL_MS)]
    );
    // Housekeeping: drop this user's long-expired sessions.
    await client.query(`DELETE FROM sessions WHERE user_id = $1 AND expires_at < NOW() - INTERVAL '30 days'`, [user.id]);
    await client.query(`UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`, [user.id]);
  });

  res.cookie('session_token', sessionToken, buildAuthCookieOptions());
  await createAuditLog({
    user: { id: user.id, username: user.username, role: user.role },
    action: 'LOGIN',
    module: 'Authentication',
    entityType: 'user',
    entityId: String(user.id),
    description: `User ${user.username} logged in`,
    newValues: { role: user.role },
    ...getRequestMeta(req),
  });

  return res.status(200).json({
    success: true,
    message: 'Login successful.',
    user: publicUser(user),
    role: user.role,
    mustChangePassword: user.must_change_password,
  });
}

export async function logout(req, res) {
  const token = req.cookies?.session_token;
  if (token) {
    const result = await query(
      `UPDATE sessions s SET revoked_at = NOW()
       FROM users u
       WHERE u.id = s.user_id AND s.token_digest = $1 AND s.revoked_at IS NULL
       RETURNING u.id, u.username, u.role`,
      [digestToken(token)]
    );
    const user = result.rows[0];
    if (user) {
      await createAuditLog({
        user,
        action: 'LOGOUT',
        module: 'Authentication',
        entityType: 'user',
        entityId: String(user.id),
        description: `User ${user.username} logged out`,
        ...getRequestMeta(req),
      });
    }
  }
  res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
  return res.status(200).json({ success: true, message: 'Logged out successfully.' });
}

export async function me(req, res) {
  const result = await query(
    `SELECT u.id, u.member_id, u.username, u.email, u.role, u.account_status, u.must_change_password, u.last_login,
            u.password_changed_at, u.full_name, u.phone, u.position, u.notification_preferences,
            m.member_number, TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS member_name, m.phone AS member_phone
     FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE u.id = $1`,
    [currentUserId(req)]
  );
  const row = result.rows[0];
  return res.status(200).json({
    success: true,
    user: {
      ...publicUser(row),
      phone: row.phone || row.member_phone || null,
      position: row.position,
      member_number: row.member_number,
      display_name: row.full_name || row.member_name || row.username,
      notification_preferences: row.notification_preferences,
    },
  });
}

export async function updateProfile(req, res) {
  const userId = currentUserId(req);
  const fullName = optionalString(req.body?.name, 200);
  // Member accounts do not use email; only administrators can set one.
  const email = req.user.role === 'ADMIN' ? optionalString(req.body?.email, 255) : undefined;
  const phone = optionalString(req.body?.phone, 50);
  const position = req.user.role === 'ADMIN' ? optionalString(req.body?.position, 120) : undefined;
  if (email && !EMAIL_PATTERN.test(email)) throw badRequest('Email format is invalid.');
  if (phone && !PHONE_PATTERN.test(phone)) throw badRequest('Phone number format is invalid.');

  const updated = await withTransaction(async (client) => {
    const before = (await client.query(`SELECT full_name, email, phone, position FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
    const result = await client.query(
      `UPDATE users SET full_name = COALESCE($1, full_name), email = COALESCE($2, email), phone = COALESCE($3, phone),
              position = CASE WHEN $4::boolean THEN $5 ELSE position END, updated_at = NOW()
       WHERE id = $6 RETURNING full_name, email, phone, position`,
      [fullName, email?.toLowerCase() ?? null, phone, position !== undefined, position ?? null, userId]
    );
    // Members' contact details live on their member record as well.
    if (req.user.member_id && (email || phone)) {
      await client.query(
        `UPDATE members SET email = COALESCE($1, email), phone = COALESCE($2, phone), updated_at = NOW() WHERE id = $3`,
        [email?.toLowerCase() ?? null, phone, req.user.member_id]
      );
    }
    await createAuditLog({ client, user: req.user, action: 'PROFILE_UPDATED', module: 'Accounts', entityType: 'user', entityId: String(userId), description: 'Updated own profile', oldValues: before, newValues: result.rows[0], ...getRequestMeta(req) });
    return result.rows[0];
  });
  return res.status(200).json({ success: true, message: 'Profile updated.', profile: updated });
}

export async function updateNotificationPreferences(req, res) {
  const preferences = {
    emailNotifications: req.body?.emailNotifications !== false,
    smsNotifications: req.body?.smsNotifications === true,
    loanReminders: req.body?.loanReminders !== false,
  };
  await query(`UPDATE users SET notification_preferences = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(preferences), currentUserId(req)]);
  return res.status(200).json({ success: true, message: 'Notification settings saved.', preferences });
}

export async function forgotPassword(req, res) {
  const identifier = cleanString(req.body?.usernameOrEmail, 255);
  if (!identifier) throw badRequest('Email or username is required.');
  const genericResponse = { success: true, message: 'If an account exists, reset instructions have been sent.' };

  const user = await findUserByIdentifier(identifier);
  if (!user || user.account_status !== 'ACTIVE') return res.status(200).json(genericResponse);

  const token = generateSecureToken(32);
  const digest = digestToken(token);
  await withTransaction(async (client) => {
    // Only the newest link stays valid.
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, token_digest, expires_at)
       VALUES ($1, $2::text, $2::text, NOW() + INTERVAL '15 minutes')`,
      [user.id, digest]
    );
    await createAuditLog({ client, userId: user.id, action: 'PASSWORD_RESET_REQUESTED', module: 'Authentication', entityType: 'user', entityId: String(user.id), description: 'Password reset requested', ...getRequestMeta(req) });
  });

  if (user.email) {
    const email = passwordResetEmail({ username: user.username, token });
    void sendEmailSafely({ ...email, to: user.email, relatedUserId: user.id, essential: true });
  }
  // Exposed only to automated tests; never in production responses.
  if (process.env.NODE_ENV === 'test') res.setHeader('X-Test-Reset-Token', token);
  return res.status(200).json(genericResponse);
}

export async function resetPassword(req, res) {
  const { token, newPassword, confirmPassword } = req.body || {};
  if (!token || !newPassword || !confirmPassword) throw badRequest('Token and new password are required.');
  if (newPassword !== confirmPassword) throw badRequest('Passwords do not match.');
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.isValid) throw badRequest(policy.errors[0]);

  const newHash = await hashPassword(newPassword);
  const user = await withTransaction(async (client) => {
    const tokenResult = await client.query(
      `SELECT t.id, t.user_id FROM password_reset_tokens t
       WHERE t.token_digest = $1 AND t.used_at IS NULL AND t.expires_at > NOW()
       FOR UPDATE`,
      [digestToken(String(token))]
    );
    const match = tokenResult.rows[0];
    if (!match) throw badRequest('This reset link is invalid or has expired. Please request a new one.');

    const userResult = await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE, updated_at = NOW()
       WHERE id = $2 RETURNING id, username, role, account_status`,
      [newHash, match.user_id]
    );
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [match.user_id]);
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [match.user_id]);
    const updatedUser = userResult.rows[0];
    await createAuditLog({ client, user: updatedUser, action: 'PASSWORD_RESET_COMPLETED', module: 'Authentication', entityType: 'user', entityId: String(updatedUser.id), description: `Password reset completed for ${updatedUser.username}`, ...getRequestMeta(req) });
    await notifyUser(client, updatedUser.id, { type: 'password_reset', title: 'Password changed', message: 'Your password was reset. If this was not you, contact the ACIFAC office immediately.', severity: 'warning' });
    return updatedUser;
  });

  if (user.account_status !== 'ACTIVE') {
    return res.status(200).json({ success: true, message: 'Password reset successfully, but this account is not active. Please contact the ACIFAC office.' });
  }
  return res.status(200).json({ success: true, message: 'Password reset successfully. You can now sign in.' });
}

export async function changePassword(req, res) {
  const userId = currentUserId(req);
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || !confirmPassword) throw badRequest('All fields are required.');
  if (newPassword !== confirmPassword) throw badRequest('Passwords do not match.');
  if (currentPassword === newPassword) throw badRequest('New password must differ from the current password.');
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.isValid) throw badRequest(policy.errors[0]);

  const userResult = await query(`SELECT id, username, role, password_hash FROM users WHERE id = $1`, [userId]);
  const user = userResult.rows[0];
  if (!(await verifyPassword(currentPassword, user.password_hash))) throw badRequest('Current password is incorrect.');

  const newHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [newHash, userId]
    );
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await createAuditLog({ client, user, action: 'PASSWORD_CHANGED', module: 'Authentication', entityType: 'user', entityId: String(userId), description: `Password changed for ${user.username}`, ...getRequestMeta(req) });
  });

  res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
  return res.status(200).json({ success: true, message: 'Password changed successfully. Please sign in again.' });
}
