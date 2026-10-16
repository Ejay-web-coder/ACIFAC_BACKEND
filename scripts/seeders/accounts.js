import { hashPassword } from '../../src/utils/password.js';
import { actingRequest } from './support.js';

// Sample logins never get emails or texts: their addresses (@example.com) and
// phone numbers are made up. In-app loan reminders stay on.
const QUIET = { emailNotifications: false, smsNotifications: false, loanReminders: true };

// The administrator who "records" all the sample data. An existing active
// administrator is used as is (its password is not touched); otherwise one is
// created: admin / ctx.passwords.admin.
export async function seedAdmin(ctx) {
  const existing = (await ctx.client.query(
    `SELECT id, username, role, full_name FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE' ORDER BY id LIMIT 1`
  )).rows[0];
  if (existing) {
    ctx.admin = existing;
    ctx.logins.push(['Administrator', existing.username, '(its current password)']);
  } else {
    ctx.admin = (await ctx.client.query(
      `INSERT INTO users (username, email, password_hash, role, account_status, must_change_password, password_changed_at, full_name, notification_preferences)
       VALUES ('admin', 'admin@example.com', $1, 'ADMIN', 'ACTIVE', FALSE, NOW(), 'ACIFAC Administrator', $2::jsonb)
       RETURNING id, username, role, full_name`,
      [await hashPassword(ctx.passwords.admin), JSON.stringify(QUIET)]
    )).rows[0];
    ctx.logins.push(['Administrator', 'admin', ctx.passwords.admin]);
  }
  ctx.req = actingRequest(ctx.admin);
}

// The members' own active logins, for trying the member pages: [{ member, username }].
// All sample members share one password, so it is hashed once.
export async function createMemberLogins(ctx, logins) {
  if (!logins.length) return;
  const hash = await hashPassword(ctx.passwords.member);
  await ctx.client.query(
    `INSERT INTO users (member_id, username, email, password_hash, role, account_status, must_change_password, password_changed_at, full_name, phone, notification_preferences)
     SELECT r.member_id, r.username, r.email, $6, 'MEMBER', 'ACTIVE', FALSE, NOW(), r.full_name, r.phone, $7::jsonb
     FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[]) AS r(member_id, username, email, full_name, phone)`,
    [logins.map((l) => l.member.id), logins.map((l) => l.username), logins.map((l) => l.member.email), logins.map((l) => l.member.fullName), logins.map((l) => l.member.phone),
      hash, JSON.stringify(QUIET)]
  );
  ctx.count('member logins', logins.length);
}

// juan.delacruz for Juan Dela Cruz.
export const loginName = (firstName, lastName) => `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
