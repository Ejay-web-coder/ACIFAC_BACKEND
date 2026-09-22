import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../src/utils/password.js';
import { matchSessionToken } from '../src/utils/auth.js';
import { buildAuditLogPayload, summarizeAuditChanges } from '../src/utils/audit.js';

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
