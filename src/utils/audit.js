import { query } from '../config/db.js';

const SENSITIVE_FIELD_NAMES = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'token_hash',
  'session_token',
  'sessionToken',
  'auth_token',
  'authToken',
  'secret',
  'api_key',
  'apiKey',
  'refresh_token',
  'refreshToken',
  'cookie',
  'jwt',
  'access_token',
  'accessToken'
]);

function isSensitiveField(key) {
  return SENSITIVE_FIELD_NAMES.has(String(key).toLowerCase());
}

export function sanitizeAuditValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeAuditValue(entry));
  if (typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, nestedValue]) => {
      if (isSensitiveField(key)) return acc;
      acc[key] = sanitizeAuditValue(nestedValue);
      return acc;
    }, {});
  }
  return String(value);
}

export function summarizeAuditChanges(oldValues = {}, newValues = {}) {
  const fieldOrder = [];
  const seen = new Set();

  for (const source of [oldValues || {}, newValues || {}]) {
    for (const key of Object.keys(source || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        fieldOrder.push(key);
      }
    }
  }

  const summary = [];

  for (const field of fieldOrder) {
    if (isSensitiveField(field)) continue;
    const oldValue = sanitizeAuditValue(oldValues?.[field]);
    const newValue = sanitizeAuditValue(newValues?.[field]);
    if (Object.is(oldValue, newValue)) continue;
    summary.push({ field, from: oldValue, to: newValue });
  }

  return summary;
}

export function buildAuditLogPayload({
  user,
  userId,
  action,
  module = 'System',
  entityType = 'record',
  entityId = null,
  description = '',
  oldValues = {},
  newValues = {},
  targetUserId = null,
  ipAddress = null,
  userAgent = null,
  status = 'SUCCESS',
  details = null,
}) {
  const actor = user ?? { id: userId ?? null, username: null, role: null, email: null };
  const safeOldValues = sanitizeAuditValue(oldValues);
  const safeNewValues = sanitizeAuditValue(newValues);
  const safeDetails = sanitizeAuditValue(details ?? {
    module,
    entity_type: entityType,
    entity_id: entityId,
    description,
    old_values: safeOldValues,
    new_values: safeNewValues,
    status,
  });

  return {
    user_id: actor?.user_id ?? actor?.id ?? userId ?? null,
    user_name_snapshot: actor?.username ?? null,
    user_role_snapshot: actor?.role ?? null,
    action,
    module,
    entity_type: entityType,
    entity_id: entityId,
    description,
    old_values: safeOldValues,
    new_values: safeNewValues,
    target_user_id: targetUserId,
    ip_address: ipAddress,
    user_agent: userAgent,
    status,
    details: safeDetails,
  };
}

export async function createAuditLog({
  user,
  userId,
  action,
  module = 'System',
  entityType = 'record',
  entityId = null,
  description = '',
  oldValues = {},
  newValues = {},
  targetUserId = null,
  ipAddress = null,
  userAgent = null,
  status = 'SUCCESS',
  details = null,
}) {
  const payload = buildAuditLogPayload({
    user,
    userId,
    action,
    module,
    entityType,
    entityId,
    description,
    oldValues,
    newValues,
    targetUserId,
    ipAddress,
    userAgent,
    status,
    details,
  });

  try {
    await query(
      `INSERT INTO audit_logs (
        user_id, user_name_snapshot, user_role_snapshot, action, module, entity_type, entity_id,
        description, old_values, new_values, target_user_id, ip_address, user_agent, status, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())`,
      [
        payload.user_id,
        payload.user_name_snapshot,
        payload.user_role_snapshot,
        payload.action,
        payload.module,
        payload.entity_type,
        payload.entity_id,
        payload.description,
        JSON.stringify(payload.old_values),
        JSON.stringify(payload.new_values),
        payload.target_user_id,
        payload.ip_address,
        payload.user_agent,
        payload.status,
        JSON.stringify(payload.details),
      ]
    );
    return payload;
  } catch (error) {
    console.error('Audit log failed:', error);
    return null;
  }
}

