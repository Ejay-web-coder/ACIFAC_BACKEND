import { query } from '../config/db.js';
import { normalizePhilippineMobile } from '../utils/phone.js';

// The email and mobile number an account is known by, for signing in and for
// password resets. Email: the login email or the email on the member record.
// Mobile: the number on the member record (kept by the office), else the
// account's own. Every account that matches is returned, so the caller can
// refuse an address shared by several accounts (a family may share a number).

const accountSelect = `
  SELECT u.*, TRIM(CONCAT_WS(' ', m.first_name, m.last_name)) AS member_name,
         COALESCE(NULLIF(TRIM(m.phone), ''), u.phone) AS login_phone
  FROM users u LEFT JOIN members m ON m.id = u.member_id`;

export async function findAccountsByEmail(email, db = { query }) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address) return [];
  const rows = (await db.query(
    `${accountSelect} WHERE LOWER(u.email) = $1 OR LOWER(TRIM(m.email)) = $1 ORDER BY u.id`,
    [address]
  )).rows;
  // The login email is unique, so an account signed in with it is never ambiguous.
  const byLoginEmail = rows.filter((row) => String(row.email ?? '').toLowerCase() === address);
  return byLoginEmail.length ? byLoginEmail : rows;
}

// Numbers are saved in many formats (0917..., +63 917..., 0917-123-...): SQL
// narrows the candidates by their last 10 digits, the match is made on the
// normalized number.
export async function findAccountsByPhone(phone, db = { query }) {
  const normalized = normalizePhilippineMobile(phone);
  if (!normalized) return [];
  const rows = (await db.query(
    `${accountSelect}
     WHERE regexp_replace(COALESCE(NULLIF(TRIM(m.phone), ''), u.phone, ''), '\\D', '', 'g') LIKE '%' || $1
     ORDER BY u.id`,
    [normalized.slice(-10)]
  )).rows;
  return rows.filter((row) => normalizePhilippineMobile(row.login_phone) === normalized);
}
