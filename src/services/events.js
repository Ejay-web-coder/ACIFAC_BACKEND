import { createDedicatedClient } from '../config/db.js';
import { loadSessionUser } from '../middleware/auth.js';

// Live updates: PostgreSQL triggers call pg_notify('acifac_events', {table, op,
// memberId?, userId?}) after a change commits. One LISTEN connection per backend
// instance receives them and forwards a minimal {table, op} message over
// Server-Sent Events to the connected browsers that are allowed to see it.
// Clients then re-fetch through the normal authorised API, so no record data
// ever travels over this channel.

const ADMIN_ONLY_TABLES = new Set(['users', 'kadiwa_inventory', 'kadiwa_sales', 'document_scans']);
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

// GET /api/events (behind requireAuth)
export function eventStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ live: isListening() })}\n\n`);

  const connection = { res, user: req.user };
  connections.add(connection);

  // The heartbeat also re-checks the session so a revoked or deactivated
  // account stops receiving updates within one interval.
  const heartbeat = setInterval(async () => {
    try {
      const session = await loadSessionUser(req.cookies?.session_token);
      if (!session || session.account_status !== 'ACTIVE') {
        res.write('event: session-ended\ndata: {}\n\n');
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
