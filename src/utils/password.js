import bcrypt from 'bcryptjs';

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
