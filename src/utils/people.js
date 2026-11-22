// The name shown for the account that recorded something (on receipts and
// histories): the person's full name (every administrator has one), else the
// username. `alias` is the SQL alias of the users row.
export const displayName = (alias) => `COALESCE(NULLIF(BTRIM(${alias}.full_name), ''), ${alias}.username)`;

/** The name of the account in `user` (req.user), for records the server names itself. */
export function recorderName(user) {
  return String(user?.full_name || '').trim() || String(user?.username || '').trim() || 'Administrator';
}
