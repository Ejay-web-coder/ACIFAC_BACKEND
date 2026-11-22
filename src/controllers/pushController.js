import { badRequest, cleanString, currentUserId } from '../utils/http.js';
import { countSubscriptions, getVapidKeys, removeSubscription, saveSubscription } from '../services/pushService.js';
import { fromBase64Url, isAllowedPushEndpoint } from '../services/webPush.js';

// Phone notifications for the signed-in account: the key the browser needs to
// subscribe, and adding or removing this browser.

// GET /api/push/key
export async function getPushKey(req, res) {
  const { publicKey } = await getVapidKeys();
  return res.json({ success: true, publicKey, devices: await countSubscriptions(currentUserId(req)) });
}

function readSubscription(body) {
  const endpoint = cleanString(body?.endpoint, 2000);
  const p256dh = cleanString(body?.keys?.p256dh, 200);
  const auth = cleanString(body?.keys?.auth, 100);
  if (!isAllowedPushEndpoint(endpoint)) throw badRequest('This browser\'s push service is not supported.');
  if (fromBase64Url(p256dh).length !== 65 || fromBase64Url(auth).length < 16) throw badRequest('The browser sent incomplete notification keys. Turn phone notifications off and on again.');
  return { endpoint, p256dh, auth };
}

// POST /api/push/subscriptions { endpoint, keys: { p256dh, auth } }
export async function subscribePush(req, res) {
  const subscription = readSubscription(req.body);
  await saveSubscription(currentUserId(req), { ...subscription, userAgent: req.get('user-agent') });
  return res.status(201).json({ success: true, message: 'Phone notifications are on for this device.' });
}

// DELETE /api/push/subscriptions { endpoint }
export async function unsubscribePush(req, res) {
  const endpoint = cleanString(req.body?.endpoint, 2000);
  if (!endpoint) throw badRequest('Which device? The endpoint is missing.');
  await removeSubscription(currentUserId(req), endpoint);
  return res.json({ success: true, message: 'Phone notifications are off for this device.' });
}
