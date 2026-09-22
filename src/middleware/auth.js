import { query } from '../config/db.js';
import { buildAuthCookieOptions, digestToken, matchSessionToken } from '../utils/auth.js';

export async function requireAuth(req, res, next) {
  try {
    const sessionToken = req.cookies?.session_token;

    if (!sessionToken) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    const directSession = await query(
      `SELECT s.*, u.id AS user_id, u.username, u.role, u.account_status, u.member_id,
              u.must_change_password, u.last_login, u.password_changed_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_digest = $1
         AND s.expires_at > NOW()
         AND s.revoked_at IS NULL
       LIMIT 1`,
      [digestToken(sessionToken)]
    );

    let validSession = directSession.rows[0] || null;

    if (!validSession) {
      const legacySessions = await query(
        `SELECT s.*, u.id AS user_id, u.username, u.role, u.account_status, u.member_id,
                u.must_change_password, u.last_login, u.password_changed_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_digest IS NULL
           AND s.expires_at > NOW()
           AND s.revoked_at IS NULL
         ORDER BY s.created_at DESC`,
        []
      );

      for (const session of legacySessions.rows) {
        if (await matchSessionToken(sessionToken, session.token_hash)) {
          validSession = session;
          break;
        }
      }
    }

    if (!validSession) {
      res.clearCookie('session_token', buildAuthCookieOptions());
      return res.status(401).json({ message: 'Session expired or invalid.' });
    }

    req.user = validSession;
    return next();
  } catch (error) {
    console.error('requireAuth error:', error);
    return res.status(500).json({ message: 'Authentication failed.' });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Admin access required.' });
  }

  return next();
}

export function requireMember(req, res, next) {
  if (!req.user || !['ADMIN', 'MEMBER'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Member access required.' });
  }

  return next();
}
