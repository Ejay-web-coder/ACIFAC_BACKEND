import { query } from '../config/db.js';
import { buildAuthCookieOptions, digestToken, SESSION_IDLE_TIMEOUT_MINUTES } from '../utils/auth.js';
import { createAuditLog } from '../utils/audit.js';
import { getRequestMeta } from '../utils/http.js';

// Routes a user with must_change_password may still call (reading their own
// notifications and the live-update stream keeps the page header working).
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/session', '/api/auth/change-password', '/api/auth/logout', '/api/events']);
const PASSWORD_CHANGE_ALLOWED_GET = new Set(['/api/notifications']);

// Every request the person makes counts as activity, except the live-update
// stream (which stays open and reconnects by itself) and requests the browser
// marks with "X-Session-Activity: passive" (background refreshes and checks).
const PASSIVE_PATHS = new Set(['/api/events']);
// last_activity_at is written at most this often per session.
const ACTIVITY_WRITE_INTERVAL_SECONDS = 30;
const IDLE_TIMEOUT_SECONDS = SESSION_IDLE_TIMEOUT_MINUTES * 60;

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';
export const SESSION_IDLE_MESSAGE = 'Your session expired because of inactivity. Please log in again.';

// The session for a cookie token with its user, including idle sessions
// (idle_expired = true); null when there is no live session.
export async function loadSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length > 200) return null;
  const result = await query(
    `SELECT s.id AS session_id, s.expires_at,
            s.last_activity_at <= NOW() - make_interval(mins => $2) AS idle_expired,
            s.last_activity_at < NOW() - make_interval(secs => $3) AS activity_stale,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (s.last_activity_at + make_interval(mins => $2) - NOW()))))::int AS idle_expires_in_seconds,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (s.expires_at - NOW()))))::int AS session_expires_in_seconds,
            u.id AS user_id, u.username, u.email, u.role, u.account_status,
            u.member_id, u.must_change_password, u.last_login, u.password_changed_at, u.full_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_digest = $1
       AND s.expires_at > NOW()
       AND s.revoked_at IS NULL
     LIMIT 1`,
    [digestToken(sessionToken), SESSION_IDLE_TIMEOUT_MINUTES, ACTIVITY_WRITE_INTERVAL_SECONDS]
  );
  return result.rows[0] || null;
}

// The signed-in user for a session cookie, or null when the session has
// ended, expired or been idle for too long.
export async function loadSessionUser(sessionToken) {
  const session = await loadSession(sessionToken);
  return session && !session.idle_expired ? session : null;
}

// Revokes a session that went idle past the timeout and records it (once).
export async function endIdleSession(session, meta = {}) {
  const revoked = await query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [session.session_id]);
  if (!revoked.rowCount) return;
  await createAuditLog({
    user: { id: session.user_id, username: session.username, role: session.role },
    action: 'SESSION_EXPIRED',
    module: 'Authentication',
    entityType: 'user',
    entityId: String(session.user_id),
    description: `Signed out after ${SESSION_IDLE_TIMEOUT_MINUTES} minutes of inactivity`,
    details: { reason: 'inactivity' },
    ...meta,
  });
}

export async function requireAuth(req, res, next) {
  try {
    const session = await loadSession(req.cookies?.session_token);

    if (!session) {
      res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
      return res.status(401).json({ success: false, code: 'SESSION_INVALID', message: SESSION_EXPIRED_MESSAGE });
    }

    if (session.idle_expired) {
      await endIdleSession(session, getRequestMeta(req));
      res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
      return res.status(401).json({ success: false, code: 'SESSION_IDLE_TIMEOUT', message: SESSION_IDLE_MESSAGE });
    }

    if (session.account_status !== 'ACTIVE') {
      await query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [session.user_id]);
      res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
      return res.status(401).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'Your account is inactive or locked. Please contact the ACIFAC office.' });
    }

    const path = req.originalUrl.split('?')[0];
    const { idle_expired: _idle, activity_stale: activityStale, idle_expires_in_seconds: idleExpiresInSeconds, session_expires_in_seconds: sessionExpiresInSeconds, ...user } = session;
    const passive = PASSIVE_PATHS.has(path) || req.get('x-session-activity') === 'passive';
    const touch = !passive && activityStale;
    if (touch) await query('UPDATE sessions SET last_activity_at = NOW() WHERE id = $1', [session.session_id]);

    req.user = { ...user, id: user.user_id };
    req.authSession = {
      id: session.session_id,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      idleExpiresInSeconds: touch ? IDLE_TIMEOUT_SECONDS : idleExpiresInSeconds,
      sessionExpiresInSeconds,
    };

    const allowedWhileChanging = PASSWORD_CHANGE_ALLOWED.has(path) || (req.method === 'GET' && PASSWORD_CHANGE_ALLOWED_GET.has(path));
    if (session.must_change_password && !allowedWhileChanging) {
      return res.status(403).json({ success: false, code: 'PASSWORD_CHANGE_REQUIRED', message: 'You must change your password before continuing.' });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }
  return next();
}

export function requireMember(req, res, next) {
  if (!req.user || req.user.role !== 'MEMBER' || !req.user.member_id) {
    return res.status(403).json({ success: false, message: 'A member account is required.' });
  }
  return next();
}
