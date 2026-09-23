import { query } from '../config/db.js';
import { buildAuthCookieOptions, digestToken } from '../utils/auth.js';

// Routes a user with must_change_password may still call (reading their own
// notifications and the live-update stream keeps the page header working).
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout', '/api/events']);
const PASSWORD_CHANGE_ALLOWED_GET = new Set(['/api/notifications']);

export async function loadSessionUser(sessionToken) {
  if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length > 200) return null;
  const result = await query(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username, u.email, u.role, u.account_status,
            u.member_id, u.must_change_password, u.last_login, u.password_changed_at, u.full_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_digest = $1
       AND s.expires_at > NOW()
       AND s.revoked_at IS NULL
     LIMIT 1`,
    [digestToken(sessionToken)]
  );
  return result.rows[0] || null;
}

export async function requireAuth(req, res, next) {
  try {
    const session = await loadSessionUser(req.cookies?.session_token);

    if (!session) {
      res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
      return res.status(401).json({ success: false, code: 'SESSION_INVALID', message: 'Your session has expired. Please sign in again.' });
    }

    if (session.account_status !== 'ACTIVE') {
      await query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [session.user_id]);
      res.clearCookie('session_token', buildAuthCookieOptions({ includeMaxAge: false }));
      return res.status(401).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'Your account is inactive or locked. Please contact the ACIFAC office.' });
    }

    req.user = { ...session, id: session.user_id };

    const path = req.originalUrl.split('?')[0];
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
