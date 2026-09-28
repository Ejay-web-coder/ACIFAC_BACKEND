import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../src/utils/password.js';
import { buildResetGrantCookieOptions, generateVerificationCode, matchSessionToken } from '../src/utils/auth.js';
import { buildAuditLogPayload, summarizeAuditChanges } from '../src/utils/audit.js';
import { passwordResetCodeEmail } from '../src/services/emailTemplates.js';

test('generateVerificationCode returns exactly six random digits', () => {
  const codes = new Set();
  for (let index = 0; index < 2000; index += 1) {
    const code = generateVerificationCode();
    assert.match(code, /^\d{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 1990, 'codes do not repeat in practice');
  assert.ok([...codes].some((code) => code.startsWith('0')), 'leading zeros are kept');
});

test('password reset code email carries the code and expiry, and no link', () => {
  const email = passwordResetCodeEmail({ code: '482913', expiresInMinutes: 10 });
  assert.equal(email.subject, 'ACIFAC Password Reset');
  assert.match(email.text, /Your verification code is:\n\n482913\n\nThis code expires in 10 minutes\./);
  assert.match(email.text, /If you did not request a password reset, you can ignore this email\./);
  assert.ok(email.html.includes('482913') && !email.html.includes('href'));
});

test('reset grant cookie is httpOnly, short-lived and limited to the auth routes', () => {
  const options = buildResetGrantCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.path, '/api/auth');
  assert.equal(options.maxAge, 10 * 60 * 1000);
});

test('validatePasswordPolicy rejects weak passwords', () => {
  assert.equal(validatePasswordPolicy('weak').isValid, false);
  assert.equal(validatePasswordPolicy('StrongPass1!').isValid, true);
});

test('password hashing and verification works', async () => {
  const password = 'StrongPass1!';
  const hash = await hashPassword(password);
  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('WrongPass1!', hash), false);
});

test('matchSessionToken verifies bcrypt-hashed session tokens', async () => {
  const token = 'session-token-123';
  const hash = await bcrypt.hash(token, 12);

  assert.equal(await matchSessionToken(token, hash), true);
  assert.equal(await matchSessionToken('wrong-token', hash), false);
});

test('buildAuditLogPayload removes sensitive credentials and records actor identity', () => {
  const payload = buildAuditLogPayload({
    user: { id: 7, username: 'admin', role: 'ADMIN', email: 'admin@acifac.org' },
    action: 'MEMBER_UPDATED',
    module: 'Members',
    entityType: 'member',
    entityId: 42,
    description: 'Updated member details',
    oldValues: { phone: '09123456789', address: 'Barangay A', password_hash: 'hash123' },
    newValues: { phone: '09987654321', address: 'Barangay B', password_hash: 'newhash' },
    ipAddress: '127.0.0.1',
    userAgent: 'Mozilla/5.0',
    status: 'SUCCESS'
  });

  assert.equal(payload.user_id, 7);
  assert.equal(payload.user_name_snapshot, 'admin');
  assert.equal(payload.user_role_snapshot, 'ADMIN');
  assert.equal(payload.module, 'Members');
  assert.equal(payload.entity_type, 'member');
  assert.equal(payload.entity_id, 42);
  assert.equal(payload.old_values.phone, '09123456789');
  assert.equal(payload.new_values.phone, '09987654321');
  assert.equal(payload.old_values.password_hash, undefined);
  assert.equal(payload.new_values.password_hash, undefined);
  assert.equal(payload.status, 'SUCCESS');
});

test('summarizeAuditChanges highlights concrete field differences', () => {
  const summary = summarizeAuditChanges({
    phone: '09123456789',
    address: 'Barangay A',
    password_hash: 'hash'
  }, {
    phone: '09987654321',
    address: 'Barangay B',
    password_hash: 'newhash'
  });

  assert.deepEqual(summary, [
    { field: 'phone', from: '09123456789', to: '09987654321' },
    { field: 'address', from: 'Barangay A', to: 'Barangay B' }
  ]);
});
