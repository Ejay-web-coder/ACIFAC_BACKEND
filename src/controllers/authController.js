import { query, withTransaction } from '../config/db.js';
import {
  buildAuthCookieOptions, buildResetGrantCookieOptions, digestToken, generateSecureToken, generateVerificationCode, sanitizeUser, SESSION_TTL_MS,
  LOGIN_IP_MAX_FAILURES, LOGIN_LOCK_MINUTES, LOGIN_MAX_FAILED_ATTEMPTS, RESET_CODE_MAX_ATTEMPTS, RESET_CODE_RESEND_SECONDS, RESET_CODE_TTL_MINUTES,
  RESET_CODES_PER_EMAIL_PER_HOUR, RESET_CODES_PER_IP_PER_HOUR, RESET_GRANT_COOKIE, RESET_GRANT_TTL_MINUTES,
} from '../utils/auth.js';
import { validatePasswordPolicy, hashPassword, verifyPassword } from '../utils/password.js';
import { createAuditLog } from '../utils/audit.js';
import { keepAlive } from '../utils/background.js';
import { AppError, badRequest, cleanString, currentUserId, getRequestMeta, optionalString, withCode } from '../utils/http.js';
import { sendEmailSafely } from '../services/emailService.js';
import { passwordResetCodeEmail } from '../services/emailTemplates.js';
import { isSmsConfigured, passwordResetCodeSms, sendSmsSafely } from '../services/smsService.js';
import { maskPhilippineMobile, normalizePhilippineMobile } from '../utils/phone.js';
import { notifyUser } from '../services/notificationService.js';
import { clearFailures, findActiveLock, registerFailure, throttleKeys } from '../services/loginThrottle.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+0-9()\s.-]{7,30}$/;
// Used to spend the same bcrypt time when the user does not exist.
let dummyHashPromise = null;
const getDummyHash = () => (dummyHashPromise ??= hashPassword(generateSecureToken(16)));

const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password.';
const ACCOUNT_LIMITS = { maxAttempts: LOGIN_MAX_FAILED_ATTEMPTS, lockMinutes: LOGIN_LOCK_MINUTES };
const IP_LIMITS = { maxAttempts: LOGIN_IP_MAX_FAILURES, lockMinutes: LOGIN_LOCK_MINUTES };

function sendLoginLocked(res, lock) {
  const minutes = Math.max(1, Math.ceil(lock.retryAfterSeconds / 60));
  res.setHeader('Retry-After', String(lock.retryAfterSeconds));
  return res.status(429).json({
    success: false,
    code: 'LOGIN_LOCKED',
    message: `Too many failed login attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    // Seconds left on the server's lock; the login page counts down from this.
    retryAfterSeconds: lock.retryAfterSeconds,
    lockedUntil: lock.lockedUntil,
  });
}

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
  // The lockout follows the account whichever name it is signed in with
  // (username, email or member number). Names that match no account lock the
  // same way, so a lockout never reveals whether an account exists.
  const accountKey = user ? throttleKeys.user(user.id) : throttleKeys.name(identifier);
  const ipKey = throttleKeys.ip(req.ip);
  const auditUser = user ? { id: user.id, username: user.username, role: user.role } : null;

  // Checked before the password, so a locked account gives no hint whether a
  // guess was right.
  const activeLock = await findActiveLock([accountKey, ipKey]);
  if (activeLock) {
    if (activeLock.key === accountKey) {
      // Hammering a locked account still uses up the address's allowance.
      await registerFailure(ipKey, IP_LIMITS);
      if (user) {
        await createAuditLog({ user: auditUser, action: 'LOGIN_BLOCKED', module: 'Authentication', entityType: 'user', entityId: String(user.id), description: 'Sign-in attempt while locked', ...getRequestMeta(req), status: 'FAILED', details: { reason: 'account_locked', retry_after_seconds: activeLock.retryAfterSeconds } });
      }
    }
    return sendLoginLocked(res, activeLock);
  }

  const isValidPassword = await verifyPassword(password, user?.password_hash || await getDummyHash());

  if (!user || !isValidPassword) {
    const account = await registerFailure(accountKey, { ...ACCOUNT_LIMITS, userId: user?.id ?? null });
    const address = await registerFailure(ipKey, IP_LIMITS);
    await createAuditLog({
      userId: user?.id ?? null,
      action: 'LOGIN_FAILURE',
      module: 'Authentication',
      entityType: 'user',
      entityId: user ? String(user.id) : null,
      description: 'Failed sign-in attempt',
      ...getRequestMeta(req),
      status: 'FAILED',
      details: { identifier, reason: user ? 'invalid_password' : 'user_not_found', attempts_remaining: account.attemptsRemaining },
    });

    const lock = account.locked ? account : address.locked ? address : null;
    if (lock) {
      await createAuditLog({
        user: auditUser,
        action: account.locked ? 'LOGIN_LOCKED' : 'LOGIN_IP_LOCKED',
        module: 'Authentication',
        entityType: 'user',
        entityId: user ? String(user.id) : null,
        description: account.locked
          ? `Sign-in locked for ${LOGIN_LOCK_MINUTES} minutes after ${LOGIN_MAX_FAILED_ATTEMPTS} failed attempts`
          : `Sign-ins from this address locked for ${LOGIN_LOCK_MINUTES} minutes after repeated failures`,
        ...getRequestMeta(req),
        status: 'FAILED',
        details: { identifier, locked_until: lock.lockedUntil },
      });
      return sendLoginLocked(res, lock);
    }
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE, attemptsRemaining: account.attemptsRemaining });
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
    // A successful sign-in resets the failed-attempt count.
    await clearFailures(accountKey, client);
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
            m.member_number, TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)) AS member_name,
            COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS delivery_phone,
            COALESCE(NULLIF(u.email, ''), m.email) AS notification_email
     FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE u.id = $1`,
    [currentUserId(req)]
  );
  const row = result.rows[0];
  return res.status(200).json({
    success: true,
    user: {
      ...publicUser(row),
      // The number texts go to: the member record's (kept by the office), else the account's.
      phone: row.delivery_phone || null,
      // Whether a password change code can be texted to that number.
      sms_available: isSmsConfigured() && Boolean(normalizePhilippineMobile(row.delivery_phone)),
      position: row.position,
      member_number: row.member_number,
      display_name: row.full_name || row.member_name || row.username,
      notification_preferences: row.notification_preferences,
      // Where activity emails go: the login email, else the member record's.
      notification_email: row.notification_email || null,
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
    smsNotifications: req.body?.smsNotifications !== false,
    loanReminders: req.body?.loanReminders !== false,
  };
  const before = (await query('SELECT notification_preferences FROM users WHERE id = $1', [currentUserId(req)])).rows[0]?.notification_preferences || {};
  await query(`UPDATE users SET notification_preferences = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(preferences), currentUserId(req)]);
  await createAuditLog({ user: req.user, action: 'NOTIFICATION_PREFERENCES_UPDATED', module: 'Accounts', entityType: 'user', entityId: String(currentUserId(req)), description: 'Changed notification settings', oldValues: before, newValues: preferences, ...getRequestMeta(req) });
  return res.status(200).json({ success: true, message: 'Notification settings saved.', preferences });
}

// ----- Forgot password: 6-digit code by email or text message ------------------
// 1. POST /forgot-password {email} or {phone}  sends a code (same reply for every address)
// 2. POST /verify-reset-code {email or phone, code}  sets the httpOnly reset grant cookie
// 3. POST /reset-password {newPassword, confirmPassword}  uses the grant once
// Emailed links (account setup, office resets) still call /reset-password with
// their token. Signed-in users can get a code too (POST /change-password/code)
// and change their password with it instead of the current one.

const RESET_CODE_SENT_MESSAGE = 'If an account with that email exists, a verification code has been sent.';
const RESET_CODE_TEXTED_MESSAGE = 'If an account with that mobile number exists, a verification code has been sent.';
const SMS_UNAVAILABLE_MESSAGE = 'Codes cannot be sent by text message right now. Please use your email address.';
const resetSessionExpired = () => withCode(badRequest('Your password reset session has expired. Please request a new code.'), 'RESET_SESSION_EXPIRED');

function readEmail(body) {
  const email = cleanString(body?.email, 255).toLowerCase();
  if (!email || !EMAIL_PATTERN.test(email)) throw badRequest('Please enter a valid email address.');
  return email;
}

// Where a code goes: the email address or the mobile number the person typed.
// Limits, the resend cooldown and "only the newest code counts" apply per
// address, through the digest kept in password_reset_codes.email_digest: an
// email's is of the address itself, a number's is prefixed so it can never
// equal an email's, and a signed-in user's own codes share one per account.
function readResetAddress(body) {
  if (body?.phone !== undefined) {
    const phone = normalizePhilippineMobile(cleanString(body.phone, 30));
    if (!phone) throw badRequest('Please enter a valid mobile number, like 0917 123 4567.');
    return { channel: 'sms', phone, digest: digestToken(`phone:${phone}`) };
  }
  const email = readEmail(body);
  return { channel: 'email', email, digest: digestToken(email) };
}

const accountCodeDigest = (userId) => digestToken(`account:${userId}`);

// The active account for an address: its login email, else its member
// record's (the same address account emails already go to).
async function findActiveUserByEmail(email) {
  const result = await query(
    `SELECT u.id, u.username, u.role, COALESCE(NULLIF(u.email, ''), m.email) AS delivery_email
     FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE u.account_status = 'ACTIVE' AND LOWER(COALESCE(NULLIF(u.email, ''), m.email)) = $1
     ORDER BY (LOWER(u.email) = $1) DESC NULLS LAST, u.id
     LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

// The one active account whose texts go to this number: the member record's
// mobile, else the login account's. Numbers are saved in many formats, so SQL
// narrows the candidates and the match is made on the normalized number. A
// number is not unique (a family may share one); on several accounts it
// matches none, since a code could not say which account it resets.
async function findActiveUserByPhone(phone) {
  const result = await query(
    `SELECT u.id, u.username, u.role, COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS delivery_phone
     FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE u.account_status = 'ACTIVE'
       AND regexp_replace(COALESCE(NULLIF(TRIM(m.phone), ''), u.phone, ''), '\\D', '', 'g') LIKE '%' || $1`,
    [phone.slice(-10)]
  );
  const matches = result.rows.filter((row) => normalizePhilippineMobile(row.delivery_phone) === phone);
  return matches.length === 1 ? matches[0] : null;
}

// Stores a new code for an address, enforcing the resend cooldown and the
// hourly limits. Returns { limited } (the reply for the client) or { id }.
async function storeResetCode({ digest, userId, code, ip }) {
  const codeHash = await hashPassword(code);
  return withTransaction(async (client) => {
    // One request per address at a time, so the resend cooldown cannot be raced.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`password-reset:${digest}`]);
    const usage = (await client.query(
      `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MAX(created_at) FILTER (WHERE email_digest = $1) + make_interval(secs => $3) - NOW()))))::int AS cooldown_seconds,
              COUNT(*) FILTER (WHERE email_digest = $1)::int AS email_requests,
              COUNT(*) FILTER (WHERE ip_address = $2)::int AS ip_requests
       FROM password_reset_codes
       WHERE created_at > NOW() - INTERVAL '1 hour' AND (email_digest = $1 OR ip_address = $2)`,
      [digest, ip, RESET_CODE_RESEND_SECONDS]
    )).rows[0];
    if (usage.cooldown_seconds > 0) {
      return { limited: { code: 'RESET_CODE_COOLDOWN', retryAfterSeconds: usage.cooldown_seconds, message: `Please wait ${usage.cooldown_seconds} seconds before requesting another code.` } };
    }
    if (usage.email_requests >= RESET_CODES_PER_EMAIL_PER_HOUR || usage.ip_requests >= RESET_CODES_PER_IP_PER_HOUR) {
      return { limited: { code: 'RESET_RATE_LIMITED', message: 'Too many verification code requests. Please try again later.' } };
    }
    // Only the newest code for an address can be used.
    await client.query(
      `UPDATE password_reset_codes SET invalidated_at = NOW(), invalidated_reason = 'REPLACED' WHERE email_digest = $1 AND invalidated_at IS NULL`,
      [digest]
    );
    const inserted = await client.query(
      `INSERT INTO password_reset_codes (email_digest, user_id, code_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4), $5) RETURNING id`,
      [digest, userId, codeHash, RESET_CODE_TTL_MINUTES, ip]
    );
    return { id: inserted.rows[0].id };
  });
}

function replyLimited(res, limited) {
  if (limited.retryAfterSeconds) res.setHeader('Retry-After', String(limited.retryAfterSeconds));
  return res.status(429).json({ success: false, ...limited });
}

// Sends a code by email or text message. Never throws.
function deliverCode({ channel, email, phone, code, userId }) {
  return channel === 'sms'
    ? sendSmsSafely(phone, passwordResetCodeSms({ code, expiresInMinutes: RESET_CODE_TTL_MINUTES }))
    : sendEmailSafely({ ...passwordResetCodeEmail({ code, expiresInMinutes: RESET_CODE_TTL_MINUTES }), to: email, relatedUserId: userId, essential: true });
}

function deliveryAudit(what, channel, delivery) {
  const verb = channel === 'sms' ? 'texted' : 'emailed';
  const reason = typeof delivery.skipped === 'string' ? delivery.skipped : delivery.skipped ? 'email_not_configured' : 'delivery_failed';
  return {
    description: delivery.sent ? `${what} ${verb}` : `${what} could not be ${verb}`,
    status: delivery.sent ? 'SUCCESS' : 'FAILED',
    details: { channel, delivered: Boolean(delivery.sent), ...(delivery.sent ? {} : { reason }) },
  };
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 1)}•••@${domain}`;
}

export async function forgotPassword(req, res) {
  const address = readResetAddress(req.body);
  // Decided before any lookup, so it tells nothing about which numbers have accounts.
  if (address.channel === 'sms' && !isSmsConfigured()) throw badRequest(SMS_UNAVAILABLE_MESSAGE);

  // Every address takes the same path, account or not: the same checks, a
  // stored code (for an unknown address: no account and a code nobody ever
  // receives) and the same reply. Only the email or text itself differs, and
  // it is sent after the reply, so neither the answer nor its timing tells
  // whether the address is registered.
  const user = address.channel === 'sms' ? await findActiveUserByPhone(address.phone) : await findActiveUserByEmail(address.email);
  const code = generateVerificationCode();
  const stored = await storeResetCode({ digest: address.digest, userId: user?.id ?? null, code, ip: req.ip || null });
  if (stored.limited) return replyLimited(res, stored.limited);

  // Housekeeping: codes older than a day are finished with.
  await query(`DELETE FROM password_reset_codes WHERE created_at < NOW() - INTERVAL '1 day'`)
    .catch((error) => console.error('Reset code cleanup failed:', error.message));

  if (user) {
    const meta = getRequestMeta(req);
    const auditUser = { id: user.id, username: user.username, role: user.role };
    const base = { user: auditUser, module: 'Authentication', entityType: 'user', entityId: String(user.id), ...meta };
    keepAlive((async () => {
      await createAuditLog({ ...base, action: 'PASSWORD_RESET_REQUESTED', description: 'Password reset requested' });
      const delivery = await deliverCode({ channel: address.channel, email: user.delivery_email, phone: user.delivery_phone, code, userId: user.id });
      await createAuditLog({ ...base, action: 'PASSWORD_RESET_CODE_SENT', ...deliveryAudit('Password reset code', address.channel, delivery) });
    })());
  }
  return res.status(200).json({
    success: true,
    message: address.channel === 'sms' ? RESET_CODE_TEXTED_MESSAGE : RESET_CODE_SENT_MESSAGE,
    expiresInSeconds: RESET_CODE_TTL_MINUTES * 60,
    resendAvailableInSeconds: RESET_CODE_RESEND_SECONDS,
  });
}

const CODE_RESULTS = {
  invalid: [400, 'RESET_CODE_INVALID', 'Invalid verification code.'],
  expired: [400, 'RESET_CODE_EXPIRED', 'This verification code has expired. Please request a new code.'],
  used: [400, 'RESET_CODE_USED', 'This verification code has already been used. Please request a new code.'],
  locked: [429, 'RESET_CODE_LOCKED', 'Too many incorrect attempts. Please request a new code.'],
};

function replyCode(res, result) {
  const [status, errorCode, message] = CODE_RESULTS[result];
  return res.status(status).json({ success: false, code: errorCode, message });
}

// Checks a code against the newest one stored for an address, inside the
// caller's transaction. The row lock serialises attempts, so parallel guesses
// cannot slip past the attempt limit. A wrong guess is counted.
async function checkCode(client, digest, code) {
  const row = (await client.query(
    `SELECT c.id, c.user_id, c.code_hash, c.failed_attempts, c.verified_at, c.invalidated_at, c.invalidated_reason,
            c.expires_at <= NOW() AS expired, u.username, u.role
     FROM password_reset_codes c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.email_digest = $1
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1
     FOR UPDATE OF c`,
    [digest]
  )).rows[0];
  if (!row) return { result: 'invalid' };
  if (row.invalidated_reason === 'TOO_MANY_ATTEMPTS') return { result: 'locked', row };
  if (row.invalidated_at || row.verified_at) return { result: 'used', row };
  if (row.expired) return { result: 'expired', row };

  // A code stored for an unknown address never matches: it was never sent.
  const matches = (await verifyPassword(code, row.code_hash)) && row.user_id !== null;
  if (!matches) {
    const attempts = row.failed_attempts + 1;
    const exhausted = attempts >= RESET_CODE_MAX_ATTEMPTS;
    await client.query(
      `UPDATE password_reset_codes
       SET failed_attempts = $2,
           invalidated_at = CASE WHEN $3::boolean THEN NOW() END,
           invalidated_reason = CASE WHEN $3::boolean THEN 'TOO_MANY_ATTEMPTS' END
       WHERE id = $1`,
      [row.id, attempts, exhausted]
    );
    return { result: exhausted ? 'locked' : 'invalid', row, attempts, counted: true };
  }
  return { result: 'verified', row };
}

// Records wrong guesses against the account, and optionally the verified code.
async function auditCodeCheck(req, outcome, { logVerified }) {
  const { result, row } = outcome;
  if (!row?.user_id || !(outcome.counted || (logVerified && result === 'verified'))) return;
  await createAuditLog({
    user: { id: row.user_id, username: row.username, role: row.role },
    action: result === 'verified' ? 'PASSWORD_RESET_CODE_VERIFIED' : 'PASSWORD_RESET_CODE_FAILED',
    module: 'Authentication',
    entityType: 'user',
    entityId: String(row.user_id),
    description: result === 'verified' ? 'Password reset code verified' : result === 'locked' ? 'Password reset code cancelled after too many incorrect attempts' : 'Incorrect password reset code entered',
    ...getRequestMeta(req),
    status: result === 'verified' ? 'SUCCESS' : 'FAILED',
    details: result === 'verified' ? {} : { attempts: outcome.attempts, invalidated: result === 'locked' },
  });
}

export async function verifyResetCode(req, res) {
  const address = readResetAddress(req.body);
  const code = cleanString(req.body?.code, 20);
  if (!/^\d{6}$/.test(code)) return replyCode(res, 'invalid');

  const grant = generateSecureToken(32);
  const outcome = await withTransaction(async (client) => {
    const check = await checkCode(client, address.digest, code);
    if (check.result === 'verified') {
      await client.query(
        `UPDATE password_reset_codes SET verified_at = NOW(), grant_digest = $2, grant_expires_at = NOW() + make_interval(mins => $3) WHERE id = $1`,
        [check.row.id, digestToken(grant), RESET_GRANT_TTL_MINUTES]
      );
    }
    return check;
  });

  await auditCodeCheck(req, outcome, { logVerified: true });
  if (outcome.result !== 'verified') return replyCode(res, outcome.result);

  res.cookie(RESET_GRANT_COOKIE, grant, buildResetGrantCookieOptions());
  return res.status(200).json({ success: true, message: 'Code verified. You can now create a new password.', expiresInSeconds: RESET_GRANT_TTL_MINUTES * 60 });
}

export async function resetPassword(req, res) {
  const { token, newPassword, confirmPassword } = req.body || {};
  // Emailed links send their token; the emailed-code flow presents the
  // httpOnly grant cookie set when its code was verified.
  const linkToken = typeof token === 'string' && token ? token : null;
  const grant = linkToken ? null : req.cookies?.[RESET_GRANT_COOKIE];
  if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string' || !newPassword || !confirmPassword) {
    throw badRequest('Please enter and confirm your new password.');
  }
  if (newPassword !== confirmPassword) throw badRequest('Passwords do not match.');
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.isValid) throw badRequest(policy.errors[0]);
  if (!linkToken && (typeof grant !== 'string' || !grant)) throw resetSessionExpired();

  const newHash = await hashPassword(newPassword);
  const user = await withTransaction(async (client) => {
    let userId;
    let codeId = null;
    if (linkToken) {
      const match = (await client.query(
        `SELECT t.id, t.user_id FROM password_reset_tokens t
         WHERE t.token_digest = $1 AND t.used_at IS NULL AND t.expires_at > NOW()
         FOR UPDATE`,
        [digestToken(linkToken)]
      )).rows[0];
      if (!match) throw badRequest('This reset link is invalid or has expired. Please request a new one.');
      userId = match.user_id;
    } else {
      const match = (await client.query(
        `SELECT id, user_id FROM password_reset_codes
         WHERE grant_digest = $1 AND invalidated_at IS NULL AND grant_expires_at > NOW() AND user_id IS NOT NULL
         FOR UPDATE`,
        [digestToken(grant)]
      )).rows[0];
      if (!match) throw resetSessionExpired();
      userId = match.user_id;
      codeId = match.id;
    }

    const current = (await client.query(`SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
    if (current && await verifyPassword(newPassword, current.password_hash)) {
      throw badRequest('Your new password must be different from your current password.');
    }

    const userResult = await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE, updated_at = NOW()
       WHERE id = $2 RETURNING id, username, role, account_status`,
      [newHash, userId]
    );
    // Every outstanding link, code and session of this account ends here.
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await client.query(
      `UPDATE password_reset_codes SET invalidated_at = NOW(), invalidated_reason = CASE WHEN id = $2 THEN 'USED' ELSE 'PASSWORD_CHANGED' END
       WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId, codeId]
    );
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    // Proving control of the email or number also lifts a sign-in lockout.
    await clearFailures(throttleKeys.user(userId), client);
    const updatedUser = userResult.rows[0];
    await createAuditLog({ client, user: updatedUser, action: 'PASSWORD_RESET_COMPLETED', module: 'Authentication', entityType: 'user', entityId: String(updatedUser.id), description: `Password reset completed for ${updatedUser.username}`, details: { method: linkToken ? 'email_link' : 'code' }, ...getRequestMeta(req) });
    await notifyUser(client, updatedUser.id, { type: 'password_reset', title: 'Password changed', message: 'Your password was reset. If this was not you, contact the ACIFAC office immediately.', severity: 'warning' });
    return updatedUser;
  });

  if (!linkToken) res.clearCookie(RESET_GRANT_COOKIE, buildResetGrantCookieOptions({ includeMaxAge: false }));
  if (user.account_status !== 'ACTIVE') {
    return res.status(200).json({ success: true, message: 'Password reset successfully, but this account is not active. Please contact the ACIFAC office.' });
  }
  return res.status(200).json({ success: true, message: 'Password reset successful.' });
}

// GET /api/auth/session: how long the signed-in session has left. Requests
// marked "X-Session-Activity: passive" check without counting as activity.
export async function sessionStatus(req, res) {
  const { idleTimeoutSeconds, idleExpiresInSeconds, sessionExpiresInSeconds } = req.authSession;
  return res.status(200).json({ success: true, idleTimeoutSeconds, idleExpiresInSeconds, sessionExpiresInSeconds });
}

// POST /change-password/code {channel: 'email' | 'sms'}: a code a signed-in
// user can change their password with instead of the current one. It goes to
// the email or mobile number on their own account, never to one typed in.
export async function sendPasswordChangeCode(req, res) {
  const userId = currentUserId(req);
  const channel = req.body?.channel === 'sms' ? 'sms' : 'email';
  const account = (await query(
    `SELECT COALESCE(NULLIF(u.email, ''), m.email) AS delivery_email, COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS delivery_phone
     FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = $1`,
    [userId]
  )).rows[0];
  const phone = normalizePhilippineMobile(account.delivery_phone);
  if (channel === 'email' && !account.delivery_email) throw badRequest('No email address is on file for your account.');
  if (channel === 'sms' && !phone) throw badRequest('No mobile number is on file for your account.');
  if (channel === 'sms' && !isSmsConfigured()) throw badRequest(SMS_UNAVAILABLE_MESSAGE);

  const code = generateVerificationCode();
  const stored = await storeResetCode({ digest: accountCodeDigest(userId), userId, code, ip: req.ip || null });
  if (stored.limited) return replyLimited(res, stored.limited);

  const delivery = await deliverCode({ channel, email: account.delivery_email, phone, code, userId });
  await createAuditLog({ user: req.user, action: 'PASSWORD_CHANGE_CODE_SENT', module: 'Authentication', entityType: 'user', entityId: String(userId), ...deliveryAudit('Password change code', channel, delivery), ...getRequestMeta(req) });
  if (!delivery.sent) {
    // Nothing arrived, so no cooldown should hold the next try back.
    await query(`DELETE FROM password_reset_codes WHERE id = $1`, [stored.id]);
    throw withCode(new AppError(503, `The code could not be ${channel === 'sms' ? 'texted' : 'emailed'}. Please try again or choose another option.`), 'CODE_NOT_SENT');
  }
  const sentTo = channel === 'sms' ? maskPhilippineMobile(phone) : maskEmail(account.delivery_email);
  return res.status(200).json({
    success: true,
    message: `We sent a 6-digit code to ${sentTo}.`,
    sentTo,
    expiresInSeconds: RESET_CODE_TTL_MINUTES * 60,
    resendAvailableInSeconds: RESET_CODE_RESEND_SECONDS,
  });
}

// POST /change-password {currentPassword or code, newPassword, confirmPassword}.
// The code is one from /change-password/code. Either way every session of the
// account ends and the user signs in again with the new password.
export async function changePassword(req, res) {
  const userId = currentUserId(req);
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const code = cleanString(req.body?.code, 20);
  if ((!code && !currentPassword) || !newPassword || !confirmPassword) throw badRequest('All fields are required.');
  if (newPassword !== confirmPassword) throw badRequest('Passwords do not match.');
  if (!code && currentPassword === newPassword) throw badRequest('New password must differ from the current password.');
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.isValid) throw badRequest(policy.errors[0]);
  if (code && !/^\d{6}$/.test(code)) return replyCode(res, 'invalid');

  const userResult = await query(`SELECT id, username, role, password_hash FROM users WHERE id = $1`, [userId]);
  const user = userResult.rows[0];
  if (!code && !(await verifyPassword(currentPassword, user.password_hash))) throw badRequest('Current password is incorrect.');

  const newHash = await hashPassword(newPassword);
  const outcome = await withTransaction(async (client) => {
    let codeId = null;
    if (code) {
      const check = await checkCode(client, accountCodeDigest(userId), code);
      if (check.result !== 'verified') return check;
      // Compared only after the code is proven, so it cannot be used to test
      // guesses at the current password.
      if (await verifyPassword(newPassword, user.password_hash)) return { result: 'same' };
      codeId = check.row.id;
    }
    await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = NOW(), must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [newHash, userId]
    );
    await client.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await client.query(
      `UPDATE password_reset_codes SET invalidated_at = NOW(), invalidated_reason = CASE WHEN id = $2 THEN 'USED' ELSE 'PASSWORD_CHANGED' END
       WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId, codeId]
    );
    await createAuditLog({ client, user, action: 'PASSWORD_CHANGED', module: 'Authentication', entityType: 'user', entityId: String(userId), description: `Password changed for ${user.username}`, details: { method: code ? 'code' : 'current_password' }, ...getRequestMeta(req) });
    return { result: 'changed' };
  });

  if (outcome.result === 'same') throw badRequest('New password must differ from the current password.');
  if (outcome.result !== 'changed') {
    await auditCodeCheck(req, outcome, { logVerified: false });
    return replyCode(res, outcome.result);
  }
  res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
  return res.status(200).json({ success: true, message: 'Password changed successfully. Please sign in again.' });
}
