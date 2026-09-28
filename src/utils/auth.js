import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { isProduction } from '../config/env.js';

export const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
// Signed out after this long without activity; enforced on every request.
export const SESSION_IDLE_TIMEOUT_MINUTES = 20;

const positiveInt = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

// Sign-in lockout: the third wrong password in a row locks the account for 20
// minutes. Every client address also gets a larger allowance across all
// accounts, against guessing one password for many accounts.
export const LOGIN_MAX_FAILED_ATTEMPTS = 3;
export const LOGIN_LOCK_MINUTES = 20;
export const LOGIN_IP_MAX_FAILURES = positiveInt(process.env.LOGIN_IP_MAX_FAILURES, 20);

// Emailed password reset codes.
export const RESET_CODE_TTL_MINUTES = 10;
export const RESET_CODE_MAX_ATTEMPTS = 5;
export const RESET_CODE_RESEND_SECONDS = 60;
export const RESET_CODES_PER_EMAIL_PER_HOUR = 5;
export const RESET_CODES_PER_IP_PER_HOUR = positiveInt(process.env.RESET_CODES_PER_IP_PER_HOUR, 15);
// After a code is verified, this httpOnly cookie allows one password change.
export const RESET_GRANT_COOKIE = 'password_reset_grant';
export const RESET_GRANT_TTL_MINUTES = 10;

export function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// Six random digits (000000-999999) from the operating system's CSPRNG.
export function generateVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
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

export function buildAuthCookieOptions({ includeMaxAge = true, maxAge = SESSION_TTL_MS, path = '/' } = {}) {
  // Frontend and API on different sites (e.g. vercel.app + onrender.com) need
  // SameSite=None; same-site deployments can set COOKIE_SAMESITE=lax.
  const sameSite = String(process.env.COOKIE_SAMESITE || (isProduction ? 'none' : 'lax')).toLowerCase();
  return {
    httpOnly: true,
    secure: isProduction || sameSite === 'none',
    sameSite,
    ...(includeMaxAge ? { maxAge } : {}),
    path,
  };
}

// The reset grant cookie is only ever sent to the auth routes.
export function buildResetGrantCookieOptions({ includeMaxAge = true } = {}) {
  return buildAuthCookieOptions({ includeMaxAge, maxAge: RESET_GRANT_TTL_MINUTES * 60 * 1000, path: '/api/auth' });
}

export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, password, reset_token_hash, token_hash, token_digest, ...safeUser } = user;
  return safeUser;
}
