import { createDedicatedClient, query } from '../config/db.js';
import { endIdleSession, loadSession } from '../middleware/auth.js';
import { getRequestMeta } from '../utils/http.js';

// Live updates: PostgreSQL triggers call pg_notify('acifac_events', {table, op,
// memberId?, userId?}) after a change commits. One LISTEN connection per backend
// instance receives them and forwards a minimal {table, op} message over
// Server-Sent Events to the connected browsers that are allowed to see it.
// Clients then re-fetch through the normal authorised API, so no record data
// ever travels over this channel.

const ADMIN_ONLY_TABLES = new Set([
  'users', 'kadiwa_inventory', 'kadiwa_sales', 'document_scans',
  'machinery_services', 'machinery_service_payments', 'machinery_service_rates', 'machinery_expenses', 'machinery_period_balances',
]);
const PUBLIC_TABLES = new Set(['machinery', 'announcements']);
const HEARTBEAT_MS = 25000;

const connections = new Set();
let listener = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let stopped = false;

export function canReceiveEvent(user, event) {
  if (!user || !event?.table) return false;
  if (user.role === 'ADMIN') return event.table !== 'notifications' || Number(event.userId) === Number(user.user_id);
  if (ADMIN_ONLY_TABLES.has(event.table)) return false;
  if (PUBLIC_TABLES.has(event.table)) return true;
  if (event.table === 'notifications') return Number(event.userId) === Number(user.user_id);
  return event.memberId !== undefined && event.memberId !== null && Number(event.memberId) === Number(user.member_id);
}

export function broadcast(event) {
  const message = `event: change\ndata: ${JSON.stringify({ table: event.table, op: event.op })}\n\n`;
  for (const connection of connections) {
    if (canReceiveEvent(connection.user, event)) connection.res.write(message);
  }
}

async function connectListener() {
  if (stopped) return;
  const client = createDedicatedClient();
  client.on('notification', (msg) => {
    try {
      broadcast(JSON.parse(msg.payload));
    } catch (error) {
      console.error('Invalid change event payload:', error.message);
    }
  });
  client.on('error', (error) => {
    console.error('Live update listener error:', error.message);
    scheduleReconnect(client);
  });
  client.on('end', () => scheduleReconnect(client));
  try {
    await client.connect();
    await client.query('LISTEN acifac_events');
    listener = client;
    reconnectDelay = 1000;
    console.log('Live updates: listening for database changes.');
  } catch (error) {
    console.error('Live updates unavailable:', error.message);
    scheduleReconnect(client);
  }
}

function scheduleReconnect(client) {
  if (listener === client) listener = null;
  client.removeAllListeners?.('end');
  client.end().catch(() => {});
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

export function startEventListener() {
  stopped = false;
  void connectListener();
}

export async function stopEventListener() {
  stopped = true;
  clearTimeout(reconnectTimer);
  for (const connection of connections) connection.res.end();
  connections.clear();
  if (listener) await listener.end().catch(() => {});
  listener = null;
}

export function isListening() {
  return Boolean(listener);
}

// Where live updates are off (DISABLE_LIVE_UPDATES on Vercel), browsers poll
// instead: the live-update trigger also writes each change to data_changes
// (migration 027). Changes from the last few seconds are sent again on every
// poll, so one that commits after a later one is not missed; the browser
// skips ids it has already seen.
const RECENT_SECONDS = 15;
const MAX_CHANGES = 1000;
const KEEP_HOURS = 1;
let lastPrune = 0;

// GET /api/events/changes?after=<cursor> (behind requireAuth; never counts as activity)
// { cursor, changes: [{ id, table }] }: the changes after the cursor that the
// signed-in user may see. Without a cursor it only returns where to start.
export async function changesSince(req, res) {
  const raw = String(req.query.after ?? '');
  if (!/^\d{1,18}$/.test(raw)) {
    const latest = (await query('SELECT COALESCE(MAX(id), 0)::text AS id FROM data_changes')).rows[0].id;
    return res.json({ success: true, cursor: latest, changes: [] });
  }
  const rows = (await query(
    `SELECT id::text AS id, table_name AS "table", member_id AS "memberId", user_id AS "userId"
     FROM data_changes
     WHERE id > $1::bigint OR changed_at > clock_timestamp() - make_interval(secs => $2)
     ORDER BY id LIMIT $3`,
    [raw, RECENT_SECONDS, MAX_CHANGES]
  )).rows;
  const cursor = rows.reduce((max, row) => (BigInt(row.id) > BigInt(max) ? row.id : max), raw);
  if (Date.now() - lastPrune > 60000) {
    lastPrune = Date.now();
    query(`DELETE FROM data_changes WHERE changed_at < NOW() - make_interval(hours => $1)`, [KEEP_HOURS]).catch((error) => console.error('Change log cleanup failed:', error.message));
  }
  return res.json({ success: true, cursor, changes: rows.filter((row) => canReceiveEvent(req.user, row)).map(({ id, table }) => ({ id, table })) });
}

// GET /api/events (behind requireAuth)
export function eventStream(req, res) {
  // 204 tells EventSource to stop reconnecting, so serverless hosts are not
  // hit with a reconnect loop when live updates are disabled.
  if (process.env.DISABLE_LIVE_UPDATES === 'true') return res.status(204).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ live: isListening() })}\n\n`);

  const connection = { res, user: req.user };
  connections.add(connection);

  // The heartbeat also re-checks the session so a revoked, deactivated or
  // idle (timed-out) session stops receiving updates within one interval.
  // It never counts as activity itself.
  const heartbeat = setInterval(async () => {
    try {
      const session = await loadSession(req.cookies?.session_token);
      if (!session || session.idle_expired || session.account_status !== 'ACTIVE') {
        if (session?.idle_expired) await endIdleSession(session, getRequestMeta(req));
        res.write(`event: session-ended\ndata: ${JSON.stringify({ reason: session?.idle_expired ? 'inactivity' : 'ended' })}\n\n`);
        res.end();
        return;
      }
      connection.user = { ...session, id: session.user_id };
      res.write(': keep-alive\n\n');
    } catch {
      res.write(': keep-alive\n\n');
    }
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    connections.delete(connection);
  });
}
