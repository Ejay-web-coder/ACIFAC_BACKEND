import { query } from '../config/db.js';
import { getFrontendUrl } from '../config/env.js';
import { keepAlive } from '../utils/background.js';
import { generateVapidKeys, isValidVapidKeyPair, sendWebPush } from './webPush.js';

// Phone notifications. Every in-app notification (notifications table) is
// also sent to the browsers where its account turned phone notifications on,
// so it reaches the phone even when the app is closed. Notifications are
// inserted in many places (often straight in SQL), so instead of sending from
// each of them the server sends what is waiting (pushed_at IS NULL) after
// requests that change something and from the scheduled jobs: only committed
// notifications are seen, and each is claimed once, even with several
// server instances.

const MESSAGE_LIMIT = 600;
// A notification older than this when first seen is marked sent without a push.
const STALE_HOURS = 24;
const BATCH = 200;
// Reads trigger a send at most this often per server instance (background
// refreshes create reminders during reads); changes always do.
const READ_INTERVAL_MS = 15000;
const MAX_FAILURES = 5;

let keys = null;
let sender = sendWebPush;

/** Tests replace the sender: (subscription, payload, vapid) => { status, ok, gone }. */
export function setPushSenderForTesting(fn) {
  sender = fn || sendWebPush;
}

function subject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const site = getFrontendUrl();
  return site.startsWith('https://') ? site : 'mailto:noreply@acifac.invalid';
}

// The VAPID keys: from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when both are set
// (and valid), otherwise made once and kept in push_settings, so every server
// instance signs with the same key and existing subscriptions keep working.
export async function getVapidKeys() {
  if (keys) return keys;
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) {
    if (!isValidVapidKeyPair(envPublic, envPrivate)) throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a matching key pair.');
    keys = { publicKey: envPublic, privateKey: envPrivate, subject: subject() };
    return keys;
  }
  let row = (await query('SELECT public_key, private_key FROM push_settings WHERE id')).rows[0];
  if (!row) {
    const made = generateVapidKeys();
    await query('INSERT INTO push_settings (id, public_key, private_key) VALUES (TRUE, $1, $2) ON CONFLICT (id) DO NOTHING', [made.publicKey, made.privateKey]);
    row = (await query('SELECT public_key, private_key FROM push_settings WHERE id')).rows[0];
  }
  keys = { publicKey: row.public_key, privateKey: row.private_key, subject: subject() };
  return keys;
}

export async function saveSubscription(userId, { endpoint, p256dh, auth, userAgent }) {
  // The same browser may have been used by another account before: it now belongs to this one.
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent, failure_count = 0, created_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.created_at ELSE NOW() END`,
    [userId, endpoint, p256dh, auth, String(userAgent || '').slice(0, 300)]
  );
}

export async function removeSubscription(userId, endpoint) {
  return (await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint])).rowCount;
}

export async function countSubscriptions(userId) {
  return (await query('SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id = $1', [userId])).rows[0].count;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What the service worker shows: title, text, the page to open, and a tag that groups repeats. */
export function pushPayload(row) {
  return {
    title: truncate(String(row.title || 'ACIFAC'), 120),
    body: truncate(String(row.message || ''), MESSAGE_LIMIT),
    link: row.link && String(row.link).startsWith('/') ? row.link : '/',
    tag: `acifac-${row.id}`,
    severity: row.severity || 'info',
  };
}

// Claims the waiting notifications (at most BATCH) and sends each to its
// account's browsers. Claiming first means a notification is never pushed
// twice; one that fails to send stays in the app's notification list.
async function sendWaiting() {
  const claimed = (await query(
    `WITH waiting AS (
       SELECT id FROM notifications WHERE pushed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE notifications n SET pushed_at = NOW() FROM waiting
     WHERE n.id = waiting.id
     RETURNING n.id, n.user_id, n.title, n.message, n.link, n.severity, (n.created_at < NOW() - make_interval(hours => $2)) AS stale`,
    [BATCH, STALE_HOURS]
  )).rows;
  const fresh = claimed.filter((row) => !row.stale);
  if (!fresh.length) return claimed.length;
  const subscriptions = (await query(
    `SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
     JOIN users u ON u.id = s.user_id AND u.account_status = 'ACTIVE'
     WHERE s.user_id = ANY($1::int[])`,
    [[...new Set(fresh.map((row) => row.user_id))]]
  )).rows;
  if (!subscriptions.length) return claimed.length;
  const vapid = await getVapidKeys();
  const byUser = new Map();
  for (const subscription of subscriptions) byUser.set(subscription.user_id, [...(byUser.get(subscription.user_id) || []), subscription]);

  const delivered = new Set();
  const gone = new Set();
  const failed = new Set();
  await Promise.all(fresh.flatMap((row) => (byUser.get(row.user_id) || []).map(async (subscription) => {
    try {
      const result = await sender(subscription, pushPayload(row), vapid);
      if (result.ok) delivered.add(subscription.id);
      else if (result.gone) gone.add(subscription.id);
      else {
        failed.add(subscription.id);
        console.warn(`Push not accepted (${result.status}) for subscription ${subscription.id}.`);
      }
    } catch (error) {
      failed.add(subscription.id);
      console.warn('Push delivery error:', error instanceof Error ? error.message : error);
    }
  })));
  if (gone.size) await query('DELETE FROM push_subscriptions WHERE id = ANY($1::int[])', [[...gone]]);
  if (delivered.size) await query('UPDATE push_subscriptions SET last_success_at = NOW(), failure_count = 0 WHERE id = ANY($1::int[])', [[...delivered]]);
  if (failed.size) {
    // A browser that keeps refusing (e.g. its keys changed) is dropped after a few tries.
    await query('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ANY($1::int[])', [[...failed].filter((id) => !delivered.has(id))]);
    await query('DELETE FROM push_subscriptions WHERE failure_count >= $1', [MAX_FAILURES]);
  }
  return claimed.length;
}

let running = null;
let again = false;
let lastRun = 0;

/** Sends every waiting notification. One run at a time per instance; a call during a run makes it go round once more. */
export function flushPushOutbox() {
  if (running) {
    again = true;
    return running;
  }
  lastRun = Date.now();
  running = (async () => {
    try {
      do {
        again = false;
        while ((await sendWaiting()) === BATCH) { /* more waiting */ }
      } while (again);
    } catch (error) {
      console.error('Phone notifications:', error instanceof Error ? error.message : error);
    } finally {
      running = null;
    }
  })();
  return running;
}

// Express middleware: after the response, sends the notifications the request
// created. Registered while the request is open, so on Vercel the function
// stays alive (waitUntil) until the pushes are out.
export function pushAfterResponse(req, res, next) {
  const changes = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (process.env.PUSH_NOTIFICATIONS === 'off' || (!changes && Date.now() - lastRun < READ_INTERVAL_MS)) return next();
  if (!changes) lastRun = Date.now();
  keepAlive(new Promise((resolve) => {
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      resolve(flushPushOutbox());
    };
    res.once('finish', send);
    res.once('close', send);
  }));
  return next();
}
