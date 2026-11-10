import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

// Letters and digits that can't be mistaken for each other when read off a screen (no O/0, I/l/1).
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*!?';

/** A random 10-character password that passes the password policy, for an admin to hand to a new member. */
export function generateTemporaryPassword(length = 10) {
  const pick = (set) => set[randomInt(set.length)];
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function validatePasswordPolicy(password) {
  const trimmed = String(password ?? '');
  const minLength = trimmed.length >= 8;
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  const hasNumber = /\d/.test(trimmed);
  const hasSpecial = /[^A-Za-z0-9]/.test(trimmed);

  const isValid = minLength && hasUpper && hasLower && hasNumber && hasSpecial;

  return {
    isValid,
    errors: [
      !minLength && 'Password must be at least 8 characters long.',
      !hasUpper && 'Password must contain at least one uppercase letter.',
      !hasLower && 'Password must contain at least one lowercase letter.',
      !hasNumber && 'Password must contain at least one number.',
      !hasSpecial && 'Password must contain at least one special character.'
    ].filter(Boolean)
  };
}

export async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}
