import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { isProduction } from '../config/env.js';

export const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// Session and reset tokens are 256-bit random values, so a SHA-256 digest is a
// safe, constant-time-lookup way to store them (unlike passwords).
export function digestToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export async function matchSessionToken(token, tokenHash) {
  if (!token || !tokenHash) return false;
  if (/^[a-f0-9]{64}$/.test(tokenHash)) return crypto.timingSafeEqual(Buffer.from(digestToken(token)), Buffer.from(tokenHash));
  return bcrypt.compare(token, tokenHash);
}

export function buildAuthCookieOptions({ includeMaxAge = true } = {}) {
  // Frontend and API on different sites (e.g. vercel.app + onrender.com) need
  // SameSite=None; same-site deployments can set COOKIE_SAMESITE=lax.
  const sameSite = String(process.env.COOKIE_SAMESITE || (isProduction ? 'none' : 'lax')).toLowerCase();
  return {
    httpOnly: true,
    secure: isProduction || sameSite === 'none',
    sameSite,
    ...(includeMaxAge ? { maxAge: SESSION_TTL_MS } : {}),
    path: '/',
  };
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, password, reset_token_hash, token_hash, token_digest, ...safeUser } = user;
  return safeUser;
}
