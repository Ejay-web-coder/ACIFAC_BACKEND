import { query, withTransaction } from '../config/db.js';
import { digestToken } from '../utils/auth.js';

// Failed sign-in counting and temporary lockouts. Kept in PostgreSQL, so a
// lockout holds across refreshes, tabs, browsers, direct API calls and every
// server instance (an in-memory counter would reset per serverless instance).

export const throttleKeys = {
  user: (userId) => `user:${userId}`,
  // Sign-in names that match no account: stored only as a digest.
  name: (identifier) => `name:${digestToken(String(identifier).trim().toLowerCase())}`,
  ip: (ip) => `ip:${String(ip || 'unknown').slice(0, 100)}`,
};

// The active lock among `keys` that ends last, or null.
export async function findActiveLock(keys) {
  const result = await query(
    `SELECT throttle_key, locked_until, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())))::int AS retry_after_seconds
     FROM login_throttles
     WHERE throttle_key = ANY($1::text[]) AND locked_until > NOW()
     ORDER BY locked_until DESC LIMIT 1`,
    [keys]
  );
  const row = result.rows[0];
  return row ? { key: row.throttle_key, lockedUntil: row.locked_until, retryAfterSeconds: Math.max(1, row.retry_after_seconds) } : null;
}

// Counts one failed attempt. Failures more than `windowMinutes` apart start a
// new count. Reaching `maxAttempts` locks the key for `lockMinutes` and resets
// the count, so the full allowance returns when the lock ends.
export async function registerFailure(key, { userId = null, maxAttempts, lockMinutes, windowMinutes = lockMinutes }) {
  const outcome = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO login_throttles (throttle_key, user_id) VALUES ($1, $2) ON CONFLICT (throttle_key) DO NOTHING`,
      [key, userId]
    );
    // The row lock taken here serialises concurrent failures for the same key.
    const counted = await client.query(
      `UPDATE login_throttles
       SET failed_attempts = CASE WHEN last_failed_at IS NULL OR last_failed_at <= NOW() - make_interval(mins => $2) THEN 1 ELSE failed_attempts + 1 END,
           last_failed_at = NOW(), updated_at = NOW()
       WHERE throttle_key = $1
       RETURNING failed_attempts`,
      [key, windowMinutes]
    );
    const attempts = counted.rows[0].failed_attempts;
    if (attempts < maxAttempts) return { locked: false, attemptsRemaining: maxAttempts - attempts };

    const lock = await client.query(
      `UPDATE login_throttles SET failed_attempts = 0, locked_until = NOW() + make_interval(mins => $2), updated_at = NOW()
       WHERE throttle_key = $1
       RETURNING locked_until, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())))::int AS retry_after_seconds`,
      [key, lockMinutes]
    );
    return { locked: true, attemptsRemaining: 0, lockedUntil: lock.rows[0].locked_until, retryAfterSeconds: lock.rows[0].retry_after_seconds };
  });
  // Housekeeping: counters untouched for a day and not locked are finished with.
  await query(`DELETE FROM login_throttles WHERE updated_at < NOW() - INTERVAL '1 day' AND (locked_until IS NULL OR locked_until < NOW())`)
    .catch((error) => console.error('Login throttle cleanup failed:', error.message));
  return outcome;
}

export async function clearFailures(key, client = null) {
  const runner = client ? client.query.bind(client) : query;
  await runner(`DELETE FROM login_throttles WHERE throttle_key = $1`, [key]);
}
