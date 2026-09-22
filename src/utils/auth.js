import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

export function digestToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function matchSessionToken(token, tokenHash) {
  if (!token || !tokenHash) return false;
  return bcrypt.compare(token, tokenHash);
}

export function buildAuthCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 8,
    path: '/'
  };
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, password, reset_token_hash, ...safeUser } = user;
  return safeUser;
}
