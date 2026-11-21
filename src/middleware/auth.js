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
const PASSIVE_PATHS = new Set(['/api/events', '/api/events/changes']);
// last_activity_at is written at most this often per session.
const ACTIVITY_WRITE_INTERVAL_SECONDS = 30;
export const IDLE_TIMEOUT_SECONDS = SESSION_IDLE_TIMEOUT_MINUTES * 60;

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';
export const SESSION_LOCKED_MESSAGE = `Your session was locked after ${SESSION_IDLE_TIMEOUT_MINUTES} minutes without activity. Enter your password to continue.`;
export const ACCOUNT_INACTIVE_MESSAGE = 'Your account is inactive or locked. Please contact the ACIFAC office.';

// The session for a cookie token with its user, including locked sessions
// (locked = true: idle past the timeout, or already recorded as locked); null
// when there is no live session.
export async function loadSession(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length > 200) return null;
  const result = await query(
    `SELECT s.id AS session_id, s.expires_at,
            -- Kadiwa vendors are never locked for inactivity (see VENDOR_SESSION_TTL_MS).
            (u.role <> 'VENDOR' AND (s.locked_at IS NOT NULL OR s.last_activity_at <= NOW() - make_interval(mins => $2))) AS locked,
            s.locked_at IS NOT NULL AS lock_recorded,
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

// Records that a session idle past the timeout is locked, and audits it, once.
// The idle condition is checked again, so a request that just counted as
// activity is never overtaken.
export async function lockIdleSession(session, meta = {}) {
  if (session.lock_recorded) return;
  const locked = await query(
    `UPDATE sessions SET locked_at = last_activity_at + make_interval(mins => $2)
     WHERE id = $1 AND locked_at IS NULL AND revoked_at IS NULL AND last_activity_at <= NOW() - make_interval(mins => $2)`,
    [session.session_id, SESSION_IDLE_TIMEOUT_MINUTES]
  );
  if (!locked.rowCount) return;
  await createAuditLog({
    user: { id: session.user_id, username: session.username, role: session.role },
    action: 'SESSION_LOCKED',
    module: 'Authentication',
    entityType: 'user',
    entityId: String(session.user_id),
    description: `Session locked after ${SESSION_IDLE_TIMEOUT_MINUTES} minutes of inactivity`,
    details: { reason: 'inactivity' },
    ...meta,
  });
}

// Whose locked session it is, for the lock screen after a page reload.
async function lockedAccount(userId) {
  const row = (await query(
    `SELECT u.username,
            COALESCE(NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(CONCAT_WS(' ', m.first_name, m.middle_name, m.last_name, m.suffix)), ''), u.username) AS display_name
     FROM users u LEFT JOIN members m ON m.id = u.member_id
     WHERE u.id = $1`,
    [userId]
  )).rows[0];
  return { username: row?.username ?? null, display_name: row?.display_name ?? null, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS };
}

// For GET /api/auth/me, which the page calls on every load to ask whether anyone
// is signed in: being signed out is a normal answer there (200 with user null and
// the reason), not a 401 that the browser console shows as an error. Every other
// route still answers 401, which signs the page out.
export function allowSignedOut(req, _res, next) {
  req.allowSignedOut = true;
  next();
}

function refuseSession(req, res, code, message) {
  res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
  if (req.allowSignedOut) return res.status(200).json({ success: true, user: null, code, message });
  return res.status(401).json({ success: false, code, message });
}

// A locked session keeps its cookie: it goes on once the password is entered again.
async function refuseLocked(req, res, session) {
  if (!req.allowSignedOut) return res.status(401).json({ success: false, code: 'SESSION_LOCKED', message: SESSION_LOCKED_MESSAGE });
  return res.status(200).json({ success: true, user: null, code: 'SESSION_LOCKED', message: SESSION_LOCKED_MESSAGE, locked: await lockedAccount(session.user_id) });
}

export async function requireAuth(req, res, next) {
  try {
    const session = await loadSession(req.cookies?.session_token);

    if (!session) return refuseSession(req, res, 'SESSION_INVALID', SESSION_EXPIRED_MESSAGE);

    // A deactivated account ends the session, locked or not.
    if (session.account_status !== 'ACTIVE') {
      await query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [session.user_id]);
      return refuseSession(req, res, 'ACCOUNT_INACTIVE', ACCOUNT_INACTIVE_MESSAGE);
    }

    if (session.locked) {
      await lockIdleSession(session, getRequestMeta(req));
      return await refuseLocked(req, res, session);
    }

    const path = req.originalUrl.split('?')[0];
    const { locked: _locked, lock_recorded: _lockRecorded, activity_stale: activityStale, idle_expires_in_seconds: idleExpiresInSeconds, session_expires_in_seconds: sessionExpiresInSeconds, ...user } = session;
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

// Kadiwa store vendors: they record sales for review and nothing else.
export function requireVendor(req, res, next) {
  if (!req.user || req.user.role !== 'VENDOR') {
    return res.status(403).json({ success: false, message: 'A Kadiwa vendor account is required.' });
  }
  return next();
}

export function requireAdminOrVendor(req, res, next) {
  if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'VENDOR')) {
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
