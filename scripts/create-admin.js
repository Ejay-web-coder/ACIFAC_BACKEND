import readline from 'node:readline';
import { getPool } from '../src/config/db.js';
import { hashPassword, validatePasswordPolicy } from '../src/utils/password.js';
import { findAccountsByEmail, findAccountsByPhone } from '../src/services/accountLookup.js';
import { normalizePhilippineMobile } from '../src/utils/phone.js';

// Creates an ADMIN login in the database, or with --reset sets a new password
// for one. The details are typed in here (the password is not shown), so no
// administrator credentials are kept in .env or anywhere in the repo:
//   npm run create-admin
//   npm run create-admin -- --reset
// The email and mobile number are saved on the account: with them the
// administrator can reset a forgotten password from the login page (Forgot
// password?) by email or text message, and change them later in Settings.
const reset = process.argv.includes('--reset');
const USERNAME = /^[a-z0-9._-]{3,100}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One reader for the whole run. Lines typed (or pasted) ahead, while the
// database is being checked, are kept for the next questions.
let rl;
let muted = false;
let closed = false;
let pending = null;
const typedAhead = [];
function reader() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  // Echo nothing while a password is typed.
  rl._writeToOutput = (text) => { if (!muted) write(text); };
  rl.on('line', (line) => typedAhead.push(line));
  rl.on('close', () => { closed = true; pending?.(null); });
}

async function ask(question, { hidden = false } = {}) {
  reader();
  let answer;
  if (typedAhead.length) {
    answer = typedAhead.shift();
    process.stdout.write(`${question}${hidden ? '' : answer}\n`);
  } else {
    if (hidden) process.stdout.write(question);
    muted = hidden;
    answer = closed ? null : await new Promise((resolve) => {
      pending = resolve;
      rl.question(hidden ? '' : question, resolve);
    });
    pending = null;
    muted = false;
    if (hidden) process.stdout.write('\n');
  }
  if (answer === null) throw new Error('Stopped: no answer was typed.');
  return answer.trim();
}

async function askUntil(question, check, options) {
  for (;;) {
    const answer = await ask(question, options);
    const problem = check(answer);
    if (!problem) return answer;
    console.log(`  ${problem}`);
  }
}

async function askPassword() {
  for (;;) {
    const password = await askUntil('New password: ', (value) => {
      const policy = validatePasswordPolicy(value);
      return policy.isValid ? '' : policy.errors.join(' ');
    }, { hidden: true });
    if (await ask('Type the password again: ', { hidden: true }) === password) return password;
    console.log('  The passwords do not match. Try again.');
  }
}

// The email and number must lead a reset code to this account only.
async function contactProblem(kind, value, userId) {
  const matches = kind === 'email' ? await findAccountsByEmail(value) : await findAccountsByPhone(value);
  const others = matches.filter((row) => Number(row.id) !== Number(userId));
  return others.length ? `This ${kind === 'email' ? 'email' : 'mobile number'} is already on another account (${others[0].username}). Use a different one.` : '';
}

async function main() {
  if (!process.stdin.isTTY) throw new Error('Run this in a terminal: it asks for the details and the password.');
  const pool = getPool();
  try {
    if (reset) {
      const login = (await ask('Administrator username or email: ')).toLowerCase();
      const admin = (await pool.query('SELECT id, username, role FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1', [login])).rows[0];
      if (!admin) throw new Error('No account has that username or email.');
      if (admin.role !== 'ADMIN') throw new Error('That account is not an administrator.');
      const passwordHash = await hashPassword(await askPassword());
      await pool.query(`UPDATE users SET password_hash = $1, must_change_password = FALSE, account_status = 'ACTIVE', password_changed_at = NOW(), updated_at = NOW() WHERE id = $2`, [passwordHash, admin.id]);
      await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [admin.id]);
      console.log(`Administrator "${admin.username}" password updated. Every session of the account was signed out.`);
      return;
    }

    const username = await askUntil('Username: ', (value) => (USERNAME.test(value.toLowerCase()) ? '' : 'Use 3-100 letters, numbers, dots, dashes or underscores.'));
    const taken = (await pool.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username])).rows[0];
    if (taken) throw new Error('That username is already used. Run npm run create-admin -- --reset to set a new password for it.');
    const fullName = await ask('Full name: ');
    let email;
    for (;;) {
      email = (await askUntil('Email (for password reset codes): ', (value) => (EMAIL.test(value) ? '' : 'Enter a valid email address.'))).toLowerCase();
      const problem = await contactProblem('email', email, null);
      if (!problem) break;
      console.log(`  ${problem}`);
    }
    let phone;
    for (;;) {
      const typed = await askUntil('Mobile number (for password reset codes by text, e.g. 0917 123 4567): ', (value) => (normalizePhilippineMobile(value) ? '' : 'Enter a Philippine mobile number, like 0917 123 4567.'));
      phone = normalizePhilippineMobile(typed);
      const problem = await contactProblem('phone', phone, null);
      if (!problem) break;
      console.log(`  ${problem}`);
    }
    const passwordHash = await hashPassword(await askPassword());
    await pool.query(
      `INSERT INTO users (username, email, phone, password_hash, role, account_status, must_change_password, password_changed_at, full_name)
       VALUES ($1, $2, $3, $4, 'ADMIN', 'ACTIVE', FALSE, NOW(), $5)`,
      [username.toLowerCase(), email, phone, passwordHash, fullName || null]
    );
    console.log(`Administrator "${username.toLowerCase()}" created. A forgotten password can be reset from the login page with ${email} or ${phone}.`);
  } finally {
    rl?.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
