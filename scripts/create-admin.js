import { getPool } from '../src/config/db.js';
import { hashPassword, validatePasswordPolicy } from '../src/utils/password.js';

// Creates (or, with --reset, updates the password of) an ADMIN login.
// Credentials come from environment variables so they never live in the repo:
//   ADMIN_USERNAME=... ADMIN_EMAIL=... ADMIN_PASSWORD=... [ADMIN_FULL_NAME=...] npm run create-admin
const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
const fullName = String(process.env.ADMIN_FULL_NAME || '').trim() || null;
const reset = process.argv.includes('--reset');

async function main() {
  if (!/^[a-z0-9._-]{3,100}$/.test(username) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set ADMIN_USERNAME (3-100 letters/numbers/._-) and a valid ADMIN_EMAIL.');
  }
  const policy = validatePasswordPolicy(password);
  if (!policy.isValid) throw new Error(`ADMIN_PASSWORD rejected: ${policy.errors.join(' ')}`);

  const pool = getPool();
  const passwordHash = await hashPassword(password);
  const existing = await pool.query('SELECT id, role FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $2', [username, email]);
  if (existing.rows[0] && !reset) throw new Error('A user with this username or email already exists. Re-run with --reset to set a new password.');
  if (existing.rows[0]) {
    if (existing.rows[0].role !== 'ADMIN') throw new Error('That account is not an administrator.');
    await pool.query(`UPDATE users SET password_hash = $1, must_change_password = FALSE, account_status = 'ACTIVE', password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`, [passwordHash, existing.rows[0].id]);
    await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [existing.rows[0].id]);
    console.log(`Administrator "${username}" password updated.`);
  } else {
    await pool.query(
      `INSERT INTO users (username, email, password_hash, role, account_status, must_change_password, password_changed_at, full_name)
       VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE', FALSE, NOW(), $4)`,
      [username, email, passwordHash, fullName]
    );
    console.log(`Administrator "${username}" created.`);
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
