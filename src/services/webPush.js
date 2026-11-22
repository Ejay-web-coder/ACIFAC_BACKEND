import crypto from 'node:crypto';

// Web Push with Node's own crypto (no extra package): the message is
// encrypted for the browser (RFC 8291, "aes128gcm" content coding of RFC 8188)
// and the request is signed with the server's VAPID key (RFC 8292), so the
// browser maker's push service (Google, Mozilla, Microsoft, Apple) delivers
// it to the phone even when the app is closed. Pure functions apart from
// sendWebPush, so they can be checked against the RFC's test vector.

const CURVE = 'prime256v1';
const RECORD_SIZE = 4096;
// Header (salt 16 + record size 4 + key length 1 + key 65) and GCM tag.
const OVERHEAD = 86 + 16;

export const toBase64Url = (bytes) => Buffer.from(bytes).toString('base64url');
export const fromBase64Url = (text) => Buffer.from(String(text ?? ''), 'base64url');

// A private key may come back with fewer than 32 bytes when it starts with zeros.
const pad32 = (bytes) => (bytes.length >= 32 ? bytes : Buffer.concat([Buffer.alloc(32 - bytes.length), bytes]));

/** A new VAPID key pair: the public key (65 bytes, uncompressed) and the private key, base64url. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: toBase64Url(ecdh.getPublicKey()), privateKey: toBase64Url(pad32(ecdh.getPrivateKey())) };
}

/** True when the strings are a usable P-256 key pair. */
export function isValidVapidKeyPair(publicKey, privateKey) {
  try {
    const ecdh = crypto.createECDH(CURVE);
    ecdh.setPrivateKey(pad32(fromBase64Url(privateKey)));
    return ecdh.getPublicKey().equals(fromBase64Url(publicKey));
  } catch {
    return false;
  }
}

const signingKeys = new Map();
function signingKey(publicKey, privateKey) {
  const cacheKey = `${publicKey}:${privateKey}`;
  if (!signingKeys.has(cacheKey)) {
    const point = fromBase64Url(publicKey);
    signingKeys.set(cacheKey, crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: toBase64Url(pad32(fromBase64Url(privateKey))), x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33, 65)) },
      format: 'jwk',
    }));
  }
  return signingKeys.get(cacheKey);
}

/** The Authorization header for a push to `endpoint`: a JWT signed with ES256 (valid 12 hours). */
export function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, now = Date.now()) {
  const header = toBase64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = toBase64Url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: signingKey(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${publicKey}`;
}

const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/**
 * Encrypts `plaintext` for one browser subscription ({ p256dh, auth }, base64url)
 * as a single aes128gcm record. senderPrivateKey and salt are only given by
 * tests (the RFC's example values); normally both are new for every message.
 */
export function encryptPayload(plaintext, { p256dh, auth }, { senderPrivateKey = null, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = fromBase64Url(p256dh);
  const authSecret = fromBase64Url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('The browser key (p256dh) is not a P-256 public key.');
  if (authSecret.length < 16) throw new Error('The browser auth secret is too short.');
  const data = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
  if (data.length + OVERHEAD > RECORD_SIZE) throw new Error('The push message is too long.');

  const ecdh = crypto.createECDH(CURVE);
  if (senderPrivateKey) ecdh.setPrivateKey(pad32(fromBase64Url(senderPrivateKey)));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, encrypted]);
}

// Push services the browsers use. Subscriptions to anything else are refused,
// so the server never posts to an address a user typed in.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

export function isAllowedPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

/**
 * Sends one push message. Resolves with { status, ok, gone }: gone (404/410)
 * means the browser dropped the subscription and it should be deleted.
 */
export async function sendWebPush(subscription, payload, vapid, { ttl = 24 * 3600, urgency = 'normal', fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const body = encryptPayload(JSON.stringify(payload), subscription);
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: vapidAuthorization(subscription.endpoint, vapid),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, ok: response.ok, gone: response.status === 404 || response.status === 410 };
}
