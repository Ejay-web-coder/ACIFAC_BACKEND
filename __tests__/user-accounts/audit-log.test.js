import { describe, test, expect } from '@jest/globals';
import { buildAuditLogPayload, capitalChange, sanitizeAuditValue, summarizeAuditChanges } from '../../src/utils/audit.js';

describe('Audit trail (buildAuditLogPayload, summarizeAuditChanges)', () => {
  test('records who did what, to which record', () => {
    const payload = buildAuditLogPayload({ user: { id: 1, username: 'admin', role: 'ADMIN' }, action: 'ACCOUNT_CREATED', module: 'Accounts', entityType: 'user', entityId: '21', ipAddress: '127.0.0.1' });
    expect(payload).toMatchObject({ user_id: 1, user_name_snapshot: 'admin', user_role_snapshot: 'ADMIN', action: 'ACCOUNT_CREATED', module: 'Accounts', entity_id: '21', status: 'SUCCESS' });
  });

  test('never stores passwords, tokens or document paths, even nested', () => {
    const clean = sanitizeAuditValue({ username: 'juan', password: 'Pass1234!', profile: { session_token: 'abc', id_document_path: 'ids/1.jpg', city: 'Aliaga' }, list: [{ api_key: 'k', ok: 1 }] });
    expect(clean).toEqual({ username: 'juan', profile: { city: 'Aliaga' }, list: [{ ok: 1 }] });
  });

  test('lists only the fields that changed', () => {
    expect(summarizeAuditChanges({ status: 'ACTIVE', phone: '0917' }, { status: 'INACTIVE', phone: '0917' }))
      .toEqual([{ field: 'status', from: 'ACTIVE', to: 'INACTIVE' }]);
  });

  test('a changed password shows up as no change at all', () => {
    expect(summarizeAuditChanges({ password_hash: 'a' }, { password_hash: 'b' })).toEqual([]);
  });

  test('empty or missing values give an empty summary', () => {
    expect(summarizeAuditChanges()).toEqual([]);
    expect(summarizeAuditChanges(null, null)).toEqual([]);
  });

  test('an action with no signed-in user keeps the user ID only', () => {
    const payload = buildAuditLogPayload({ userId: 7, action: 'LOGIN_FAILURE', status: 'FAILED' });
    expect(payload).toMatchObject({ user_id: 7, user_name_snapshot: null, user_role_snapshot: null, status: 'FAILED' });
  });

  test('share capital changes are written with a sign', () => {
    expect(capitalChange(150000)).toBe('+1500.00');
    expect(capitalChange(-2550)).toBe('-25.50');
  });
});
