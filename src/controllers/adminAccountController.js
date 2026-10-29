import { query, withTransaction } from '../config/db.js';
import { createAuditLog } from '../utils/audit.js';
import { generateVerificationCode, sanitizeUser } from '../utils/auth.js';
import { AppError, badRequest, cleanString, conflict, currentUserId, getRequestMeta, notFound, parseId } from '../utils/http.js';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../utils/password.js';
import { maskPhilippineMobile, normalizePhilippineMobile } from '../utils/phone.js';
import { findAccountsByEmail, findAccountsByPhone } from '../services/accountLookup.js';
import { isEmailConfigured, sendEmailSafely } from '../services/emailService.js';
import { adminAccountCreatedEmail, adminContactCodeEmail } from '../services/emailTemplates.js';
import { backfillAnnouncementNotifications, notifyAdmins } from '../services/notificationService.js';
import { isSmsConfigured, sendSmsSafely } from '../services/smsService.js';

// Administrator accounts, made in Manage Users. Every administrator has the
// one ADMIN role but their own name and position in the cooperative, both
// required; the audit log records each action under them (see audit.js).
// The email and mobile number must belong to no other account or member
// record, since administrators sign in and reset their password with them,
// and they are proved with a one-time code sent to each (the number only when
// text messages are set up).

// The cooperative's offices, offered in the form; another position can be typed in.
export const ADMIN_POSITIONS = ['Chairperson', 'Vice Chairperson', 'Secretary', 'Treasurer', 'General Manager', 'Bookkeeper', 'Cashier',
  'Board Member', 'Audit Committee Chair', 'Credit Committee Chair', 'Education Committee Chair', 'Election Committee Chair', 'Kadiwa Store Manager', 'Machinery Officer'];
const USERNAME = /^[a-z0-9._-]{3,100}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 60;
const CODES_PER_HOUR = 10;
// How long a verified address can be used to make the account.
const VERIFIED_FOR_MINUTES = 30;

const nameOf = (row) => row.member_name || row.full_name || row.username;

function readEmail(value) {
  const email = cleanString(value, 255).toLowerCase();
  if (!email) throw badRequest('Enter the new administrator\'s email.');
  if (!EMAIL.test(email)) throw badRequest('Enter a valid email address.');
  return email;
}

function readPhone(value) {
  const phone = normalizePhilippineMobile(cleanString(value, 30));
  if (!phone) throw badRequest('Enter a valid mobile number, like 0917 123 4567.');
  return phone;
}

// Why an email or number cannot be the new administrator's: another login
// account, or a member's record (the member would sign in with it), has it.
// exceptUserId: the administrator's own account, when they change their email or number in Settings.
export async function emailConflict(email, db = { query }, exceptUserId = null) {
  const account = (await findAccountsByEmail(email, db)).find((row) => Number(row.id) !== Number(exceptUserId));
  if (account) return `This email is already used by ${account.role === 'ADMIN' ? 'administrator' : 'the account of'} ${nameOf(account)}.`;
  const member = (await db.query(`SELECT member_number, first_name, last_name FROM members WHERE LOWER(TRIM(email)) = $1 LIMIT 1`, [email])).rows[0];
  if (member) return `This email is in the record of member ${member.first_name} ${member.last_name} (${member.member_number}). Use the new administrator's own email.`;
  return null;
}

export async function phoneConflict(phone, db = { query }, exceptUserId = null) {
  const account = (await findAccountsByPhone(phone, db)).find((row) => Number(row.id) !== Number(exceptUserId));
  if (account) return `This mobile number is already used by ${account.role === 'ADMIN' ? 'administrator' : 'the account of'} ${nameOf(account)}.`;
  const member = (await db.query(
    `SELECT member_number, first_name, last_name, phone FROM members WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $1`, [phone.slice(-10)]
  )).rows.find((row) => normalizePhilippineMobile(row.phone) === phone);
  if (member) return `This mobile number is in the record of member ${member.first_name} ${member.last_name} (${member.member_number}). Use the new administrator's own number.`;
  return null;
}

async function usernameConflict(username, db = { query }) {
  const taken = (await db.query('SELECT 1 FROM users WHERE LOWER(username) = $1', [username])).rows[0];
  return taken ? 'This username is already taken.' : null;
}

// GET /api/admin/accounts/admin-check?email=&phone=&username=
// Checks as the form is filled in, and says whether the number can get a code.
export async function checkAdminContact(req, res) {
  const result = { smsAvailable: isSmsConfigured(), emailAvailable: isEmailConfigured() };
  const email = cleanString(req.query.email, 255).toLowerCase();
  if (email) result.email = EMAIL.test(email) ? { problem: await emailConflict(email) } : { problem: 'Enter a valid email address.' };
  const rawPhone = cleanString(req.query.phone, 30);
  if (rawPhone) {
    const phone = normalizePhilippineMobile(rawPhone);
    result.phone = phone ? { problem: await phoneConflict(phone) } : { problem: 'Enter a valid mobile number, like 0917 123 4567.' };
  }
  const username = cleanString(req.query.username, 100).toLowerCase();
  if (username) result.username = USERNAME.test(username) ? { problem: await usernameConflict(username) } : { problem: 'Use 3 or more lowercase letters, numbers, dots, dashes or underscores.' };
  return res.status(200).json({ success: true, positions: ADMIN_POSITIONS, ...result });
}

// POST /api/admin/accounts/admin-verifications { channel: email | sms, value, name }
// Sends a 6-digit code to the new administrator's email or mobile number.
export async function sendAdminContactCode(req, res) {
  const channel = req.body?.channel === 'sms' ? 'sms' : 'email';
  const target = channel === 'sms' ? readPhone(req.body?.value) : readEmail(req.body?.value);
  const name = cleanString(req.body?.name, 200) || 'there';
  if (channel === 'sms' && !isSmsConfigured()) throw badRequest('Text messages are not set up on this server, so the mobile number is checked for conflicts only.');
  if (channel === 'email' && !isEmailConfigured()) throw new AppError(503, 'Email is not set up on this server, so no code can be sent.');
  const problem = channel === 'sms' ? await phoneConflict(target) : await emailConflict(target);
  if (problem) throw conflict(problem);

  const requester = Number(currentUserId(req));
  const code = generateVerificationCode();
  const codeHash = await hashPassword(code);
  const stored = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`admin-contact:${requester}`]);
    const usage = (await client.query(
      `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (MAX(created_at) FILTER (WHERE channel = $2 AND target = $3) + make_interval(secs => $4) - NOW()))))::int AS wait,
              COUNT(*)::int AS hour
       FROM contact_verifications WHERE requested_by = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [requester, channel, target, CODE_RESEND_SECONDS]
    )).rows[0];
    if (usage.wait > 0) throw new AppError(429, `Please wait ${usage.wait} seconds before sending another code.`);
    if (usage.hour >= CODES_PER_HOUR) throw new AppError(429, 'Too many codes were sent in the last hour. Please try again later.');
    return (await client.query(
      `INSERT INTO contact_verifications (channel, target, code_hash, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5)) RETURNING id`,
      [channel, target, codeHash, requester, CODE_TTL_MINUTES]
    )).rows[0];
  });

  const sent = channel === 'sms'
    ? await sendSmsSafely(target, `ACIFAC code to verify your number for your new administrator account: ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Do not share it.`)
    : await sendEmailSafely({ ...adminContactCodeEmail({ code, name, expiresInMinutes: CODE_TTL_MINUTES }), to: target, essential: true });
  if (!sent.sent) {
    await query('DELETE FROM contact_verifications WHERE id = $1', [stored.id]);
    throw new AppError(503, channel === 'sms' ? 'The text message could not be sent. Check the number and try again.' : 'The email could not be sent. Check the address and try again.');
  }
  return res.status(201).json({
    success: true, verificationId: Number(stored.id), channel, expiresInMinutes: CODE_TTL_MINUTES,
    sentTo: channel === 'sms' ? maskPhilippineMobile(target) : target,
    message: `A 6-digit code was sent to ${channel === 'sms' ? maskPhilippineMobile(target) : target}. Ask the new administrator for it.`,
  });
}

// POST /api/admin/accounts/admin-verifications/:id/confirm { code }
export async function confirmAdminContactCode(req, res) {
  const id = parseId(req.params.id, 'verification ID');
  const code = cleanString(req.body?.code, 10);
  if (!/^\d{6}$/.test(code)) throw badRequest('Enter the 6-digit code.');
  const outcome = await withTransaction(async (client) => {
    const row = (await client.query(
      `SELECT *, expires_at < NOW() AS expired FROM contact_verifications WHERE id = $1 AND requested_by = $2 FOR UPDATE`, [id, currentUserId(req)]
    )).rows[0];
    if (!row) throw notFound('Send a new code.');
    if (row.verified_at) return { verified: true };
    if (row.expired) return { error: 'This code has expired. Send a new one.' };
    if (row.failed_attempts >= CODE_ATTEMPTS) return { error: 'Too many wrong codes. Send a new one.' };
    if (!(await verifyPassword(code, row.code_hash))) {
      await client.query('UPDATE contact_verifications SET failed_attempts = failed_attempts + 1 WHERE id = $1', [id]);
      const left = CODE_ATTEMPTS - row.failed_attempts - 1;
      return { error: left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Send a new one.' };
    }
    await client.query('UPDATE contact_verifications SET verified_at = NOW() WHERE id = $1', [id]);
    return { verified: true };
  });
  if (outcome.error) throw badRequest(outcome.error);
  return res.status(200).json({ success: true, verified: true, message: 'Verified.' });
}

// A verified code of this administrator for this address, not yet used and still fresh.
async function takeVerification(client, { id, channel, target, requester }) {
  const row = (await client.query(
    `SELECT id FROM contact_verifications
     WHERE id = $1 AND channel = $2 AND target = $3 AND requested_by = $4 AND verified_at IS NOT NULL AND used_at IS NULL
       AND verified_at > NOW() - make_interval(mins => $5)
     FOR UPDATE`,
    [id, channel, target, requester, VERIFIED_FOR_MINUTES]
  )).rows[0];
  if (!row) return false;
  await client.query('UPDATE contact_verifications SET used_at = NOW() WHERE id = $1', [row.id]);
  return true;
}

// POST /api/admin/accounts/admins
// { fullName, position, username, email, phone, password, confirmPassword, emailVerificationId, phoneVerificationId }
export async function createAdminAccount(req, res) {
  const body = req.body || {};
  const fullName = cleanString(body.fullName, 200);
  const position = cleanString(body.position, 120);
  const username = cleanString(body.username, 100).toLowerCase();
  const email = readEmail(body.email);
  const phone = readPhone(body.phone);
  if (fullName.length < 3) throw badRequest('Enter the new administrator\'s full name.');
  if (!position) throw badRequest('Choose or type the new administrator\'s position in the cooperative.');
  if (!USERNAME.test(username)) throw badRequest('Username: use 3 or more lowercase letters, numbers, dots, dashes or underscores.');
  if (!body.password || body.password !== body.confirmPassword) throw badRequest('The passwords do not match.');
  const policy = validatePasswordPolicy(body.password);
  if (!policy.isValid) throw badRequest(policy.errors[0]);
  const smsAvailable = isSmsConfigured();
  const requester = Number(currentUserId(req));
  const passwordHash = await hashPassword(body.password);

  const created = await withTransaction(async (client) => {
    // One administrator account at a time, so two cannot take the same email or number.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['admin-account-create']);
    const problem = (await usernameConflict(username, client)) || (await emailConflict(email, client)) || (await phoneConflict(phone, client));
    if (problem) throw conflict(problem);
    if (!(await takeVerification(client, { id: Number(body.emailVerificationId), channel: 'email', target: email, requester }))) {
      throw badRequest('Verify the email first: send the code and enter it.');
    }
    if (smsAvailable && !(await takeVerification(client, { id: Number(body.phoneVerificationId), channel: 'sms', target: phone, requester }))) {
      throw badRequest('Verify the mobile number first: send the code and enter it.');
    }
    const user = (await client.query(
      `INSERT INTO users (username, email, phone, password_hash, role, account_status, must_change_password, full_name, position, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ADMIN', 'ACTIVE', TRUE, $5, $6, $7, NOW(), NOW()) RETURNING *`,
      [username, email, `0${phone.slice(3)}`, passwordHash, fullName, position, requester]
    )).rows[0];
    await backfillAnnouncementNotifications(client, user.id, user.role);
    await createAuditLog({
      client, user: req.user, action: 'ADMIN_ACCOUNT_CREATED', module: 'Accounts', entityType: 'user', entityId: String(user.id),
      description: `Created the administrator account of ${fullName} (${position})`,
      newValues: { username, full_name: fullName, position, email, phone: maskPhilippineMobile(phone), email_verified: true, phone_verified: smsAvailable },
      targetUserId: user.id, ...getRequestMeta(req),
    });
    await notifyAdmins(client, {
      type: 'admin_account_created', title: `New administrator: ${fullName}`.slice(0, 200), severity: 'info', link: '/settings',
      message: `${req.user.full_name || req.user.username} made an administrator account for ${fullName} (${position}).`,
      entityType: 'user', entityId: user.id, dedupeKey: `admin-created-${user.id}`,
    }, { exceptUserId: requester });
    return user;
  });

  void sendEmailSafely({
    ...adminAccountCreatedEmail({ name: fullName, position, username, createdBy: req.user.full_name || req.user.username }),
    to: email, relatedUserId: created.id, essential: true,
  });
  return res.status(201).json({
    success: true, user: sanitizeUser(created),
    message: `${fullName} can now sign in as ${position} with the username ${username}, the email or the mobile number, and must choose a new password at first sign-in.`,
  });
}

// ----- Kadiwa store vendors ------------------------------------------------------------------------
// A vendor account has a name, a username and a password the administrator
// gives (no email or mobile number needed). The vendor signs in with the
// username and can only send the Kadiwa store's daily sales and expenses for
// review. The administrator can change the vendor's name and password later.

function readVendorPassword(body) {
  if (!body.password || body.password !== body.confirmPassword) throw badRequest('The passwords do not match.');
  const policy = validatePasswordPolicy(body.password);
  if (!policy.isValid) throw badRequest(policy.errors[0]);
  return body.password;
}

function readVendorName(value) {
  const fullName = cleanString(value, 200);
  if (fullName.length < 3) throw badRequest('Enter the vendor\'s full name.');
  return fullName;
}

async function lockVendor(client, id) {
  const vendor = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!vendor) throw notFound('Account not found.');
  if (vendor.role !== 'VENDOR') throw badRequest('This is not a Kadiwa vendor account.');
  return vendor;
}

// POST /api/admin/accounts/vendors { fullName, username, password, confirmPassword }
export async function createVendorAccount(req, res) {
  const body = req.body || {};
  const fullName = readVendorName(body.fullName);
  const username = cleanString(body.username, 100).toLowerCase();
  if (!USERNAME.test(username)) throw badRequest('Username: use 3 or more lowercase letters, numbers, dots, dashes or underscores.');
  const passwordHash = await hashPassword(readVendorPassword(body));

  const created = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['admin-account-create']);
    const problem = await usernameConflict(username, client);
    if (problem) throw conflict(problem);
    const user = (await client.query(
      `INSERT INTO users (username, password_hash, role, account_status, must_change_password, full_name, position, created_by, created_at, updated_at)
       VALUES ($1, $2, 'VENDOR', 'ACTIVE', FALSE, $3, 'Kadiwa Store Vendor', $4, NOW(), NOW()) RETURNING *`,
      [username, passwordHash, fullName, currentUserId(req)]
    )).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'VENDOR_ACCOUNT_CREATED', module: 'Accounts', entityType: 'user', entityId: String(user.id),
      description: `Created the Kadiwa vendor account of ${fullName}`,
      newValues: { username, full_name: fullName, role: 'VENDOR' },
      targetUserId: user.id, ...getRequestMeta(req),
    });
    return user;
  });
  return res.status(201).json({
    success: true, user: sanitizeUser(created),
    message: `${fullName} can now sign in with the username ${username} and the password you gave.`,
  });
}

// PATCH /api/admin/accounts/vendors/:id { fullName }
export async function updateVendorAccount(req, res) {
  const id = parseId(req.params.id, 'account ID');
  const fullName = readVendorName(req.body?.fullName);
  const updated = await withTransaction(async (client) => {
    const vendor = await lockVendor(client, id);
    if (vendor.full_name === fullName) return vendor;
    const row = (await client.query('UPDATE users SET full_name = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [fullName, id])).rows[0];
    await createAuditLog({
      client, user: req.user, action: 'VENDOR_ACCOUNT_UPDATED', module: 'Accounts', entityType: 'user', entityId: String(id),
      description: `Renamed Kadiwa vendor ${vendor.full_name || vendor.username} to ${fullName}`,
      oldValues: { full_name: vendor.full_name }, newValues: { full_name: fullName },
      targetUserId: id, ...getRequestMeta(req),
    });
    return row;
  });
  return res.status(200).json({ success: true, user: sanitizeUser(updated), message: 'Vendor name saved.' });
}

// POST /api/admin/accounts/vendors/:id/password { password, confirmPassword }
// Sets a new password and signs the vendor out everywhere.
export async function setVendorPassword(req, res) {
  const id = parseId(req.params.id, 'account ID');
  const passwordHash = await hashPassword(readVendorPassword(req.body || {}));
  const vendor = await withTransaction(async (client) => {
    const row = await lockVendor(client, id);
    await client.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2',
      [passwordHash, id]
    );
    const revoked = await client.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await createAuditLog({
      client, user: req.user, action: 'VENDOR_PASSWORD_CHANGED', module: 'Accounts', entityType: 'user', entityId: String(id),
      description: `Changed the password of Kadiwa vendor ${row.full_name || row.username}`,
      newValues: { revoked_sessions: revoked.rowCount },
      targetUserId: id, ...getRequestMeta(req),
    });
    return row;
  });
  return res.status(200).json({ success: true, message: `New password set for ${vendor.full_name || vendor.username}. They sign in again with it.` });
}
