// Rules added for the Membership Policy and the Combined Harvester Policy, and
// the Web Push encryption, without a database.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, fromBase64Url, generateVapidKeys, isAllowedPushEndpoint, isValidVapidKeyPair, toBase64Url, vapidAuthorization } from '../src/services/webPush.js';
import { computeServiceFee, findRateForDate, seasonForDate } from '../src/services/machineryFees.js';
import { ageOn, membershipAgeError, restoreBlockedReason } from '../src/services/membershipRules.js';
import { DUES, meetingDueKinds, meetingDuesMessage } from '../src/services/dues.js';
import { pushPayload } from '../src/services/pushService.js';

test('web push: encryption matches the example of RFC 8291 (Appendix A)', () => {
  const body = encryptPayload('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: fromBase64Url('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.deepEqual(body.subarray(0, 86), fromBase64Url('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'));
  assert.deepEqual(body.subarray(86), fromBase64Url('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'));
});

test('web push: a message the browser can decrypt; too long or bad keys are refused', () => {
  const browser = crypto.createECDH('prime256v1');
  browser.generateKeys();
  const auth = crypto.randomBytes(16);
  const body = encryptPayload('{"title":"Hello"}', { p256dh: toBase64Url(browser.getPublicKey()), auth: toBase64Url(auth) });
  // What the browser does (RFC 8291 section 3.4).
  const salt = body.subarray(0, 16);
  const serverKey = body.subarray(21, 86);
  const secret = browser.computeSecret(serverKey);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), serverKey]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(body.subarray(-16));
  const plain = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
  assert.equal(plain.subarray(0, -1).toString(), '{"title":"Hello"}');
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  assert.equal(body.readUInt32BE(16), 4096);
  assert.throws(() => encryptPayload('x'.repeat(4000), { p256dh: toBase64Url(browser.getPublicKey()), auth: toBase64Url(auth) }), /too long/);
  assert.throws(() => encryptPayload('x', { p256dh: 'abc', auth: toBase64Url(auth) }), /P-256/);
});

test('web push: VAPID keys and the signed authorization', () => {
  const keys = generateVapidKeys();
  assert.equal(fromBase64Url(keys.publicKey).length, 65);
  assert.equal(fromBase64Url(keys.privateKey).length, 32);
  assert.ok(isValidVapidKeyPair(keys.publicKey, keys.privateKey));
  assert.ok(!isValidVapidKeyPair(generateVapidKeys().publicKey, keys.privateKey));
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'https://acifac.vercel.app' }, Date.UTC(2026, 10, 21));
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(key, keys.publicKey);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(fromBase64Url(head)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(fromBase64Url(claims)), { aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 10, 21) / 1000 + 12 * 3600, sub: 'https://acifac.vercel.app' });
  const point = fromBase64Url(keys.publicKey);
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, fromBase64Url(signature)));
});

test('web push: only the browsers\' push services are accepted', () => {
  for (const url of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-sg2p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/QGx']) {
    assert.ok(isAllowedPushEndpoint(url), url);
  }
  for (const url of ['http://fcm.googleapis.com/x', 'https://example.com/x', 'https://fcm.googleapis.com:8443/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'not a url', '']) {
    assert.ok(!isAllowedPushEndpoint(url), url);
  }
});

test('web push: what the phone shows', () => {
  assert.deepEqual(pushPayload({ id: 7, title: 'Meeting dues', message: 'Pay at the office.', link: '/member/dues', severity: 'info' }),
    { title: 'Meeting dues', body: 'Pay at the office.', link: '/member/dues', tag: 'acifac-7', severity: 'info' });
  const long = pushPayload({ id: 8, title: 'x', message: 'y'.repeat(900), link: 'https://elsewhere.example' });
  assert.equal(long.body.length, 600);
  assert.equal(long.link, '/', 'only pages of the app');
});

test('harvester: the season of a date, and the rate for it', () => {
  assert.deepEqual(['2026-05-31', '2026-06-01', '2026-11-30', '2026-12-01', '2027-01-15'].map(seasonForDate), ['dry', 'wet', 'wet', 'dry', 'dry']);
  const rates = [
    { serviceType: 'Harvesting', unit: 'per_100_bags', season: null, memberRate: '10', nonMemberRate: '12', effectiveFrom: '2020-12-08', effectiveTo: '2026-11-20' },
    { serviceType: 'Harvesting', unit: 'per_100_bags', season: 'dry', memberRate: '9', nonMemberRate: '10', effectiveFrom: '2026-11-21', effectiveTo: null },
    { serviceType: 'Harvesting', unit: 'bags_per_ha', season: 'wet', memberRate: '4', nonMemberRate: '5', effectiveFrom: '2026-11-21', effectiveTo: null },
  ];
  assert.equal(findRateForDate(rates, 'harvesting', '2026-05-05').memberRate, '10', 'before the seasons: the all-year rate');
  assert.equal(findRateForDate(rates, 'Harvesting', '2026-11-25').season, 'wet', 'November is the wet season');
  assert.equal(findRateForDate(rates, 'Harvesting', '2026-11-25', 'dry').season, 'dry', 'the office can pick the season');
  assert.equal(findRateForDate(rates, 'Harvesting', '2027-03-10').unit, 'per_100_bags');
  assert.equal(findRateForDate(rates.slice(0, 2), 'Harvesting', '2026-11-25'), null, 'no wet rate and no all-year rate');
});

test('harvester: wet season fee in bags per hectare', () => {
  assert.deepEqual(computeServiceFee({ unit: 'bags_per_ha', rate: '4', areaHa: '2.5', bagValue: '1000' }), { rateUsed: '4.00', feeBags: '10.00', bagValue: '1000.00', feeAmount: '10000.00' });
  assert.deepEqual(computeServiceFee({ unit: 'bags_per_ha', rate: '5', areaHa: '0.75', kgPerBag: '50', pricePerKg: '18.5' }), { rateUsed: '5.00', feeBags: '3.75', bagValue: '925.00', feeAmount: '3468.75' });
  assert.throws(() => computeServiceFee({ unit: 'bags_per_ha', rate: '4', areaHa: '0', bagValue: '1000' }), /Area \(ha\) must be more than zero/);
  assert.throws(() => computeServiceFee({ unit: 'bags_per_ha', rate: '4', areaHa: '1' }), /value of one bag/);
  assert.deepEqual(computeServiceFee({ unit: 'per_100_bags', rate: '9', totalBags: '150', bagValue: '1000' }).feeBags, '13.50', 'dry season: 9 per 100');
});

test('membership: 18 to 65 years old on the membership date', () => {
  assert.equal(ageOn('2008-01-15', '2026-01-15'), 18);
  assert.equal(ageOn('2008-01-16', '2026-01-15'), 17);
  assert.equal(ageOn('2008-02-29', '2026-02-28'), 17);
  assert.equal(ageOn('2008-02-29', '2026-03-01'), 18);
  assert.equal(membershipAgeError('2008-01-15', '2026-01-15'), null);
  assert.equal(membershipAgeError('1960-01-16', '2026-01-15'), null, '65 years and 364 days is still 65');
  assert.match(membershipAgeError('1960-01-15', '2026-01-15'), /18 to 65 .* was 66 on January 15, 2026\.$/);
  assert.match(membershipAgeError('2010-06-01', '2026-01-15'), /was 15 on/);
  assert.equal(membershipAgeError('', '2026-01-15'), null, 'no birthday: nothing to check');
});

test('membership: a member who resigned cannot be restored, except the same day', () => {
  assert.equal(restoreBlockedReason(null), null);
  assert.equal(restoreBlockedReason({ type: 'involuntary', cause: 'failedObligations', date: '2026-01-01' }, '2026-11-21'), null);
  assert.equal(restoreBlockedReason({ type: 'automatic', date: '2026-01-01' }, '2026-11-21'), null);
  assert.equal(restoreBlockedReason({ type: 'voluntary', date: '2026-11-21' }, '2026-11-21'), null, 'undo a mistake on the day');
  assert.match(restoreBlockedReason({ type: 'voluntary', date: '2026-11-20' }, '2026-11-21'), /resigned cannot come back/);
  assert.match(restoreBlockedReason({ type: 'voluntary' }, '2026-11-21'), /resigned/);
});

test('dues: what a meeting charges, and what the member is told', () => {
  assert.deepEqual([DUES.share_capital.cents, DUES.savings.cents, DUES.absence_fine.cents, DUES.transfer_fee.cents], [25000, 5000, 25000, 50000]);
  assert.deepEqual(meetingDueKinds('present'), ['share_capital', 'savings']);
  assert.deepEqual(meetingDueKinds('late'), ['share_capital', 'savings']);
  assert.deepEqual(meetingDueKinds('excused'), ['share_capital', 'savings'], 'a valid reason: no fine');
  assert.deepEqual(meetingDueKinds('absent'), ['share_capital', 'savings', 'absence_fine']);
  assert.equal(meetingDuesMessage('General Assembly', '2026-11-21', [{ kind: 'share_capital', cents: 25000 }, { kind: 'savings', cents: 5000 }]),
    'For "General Assembly" on November 21, 2026: PHP 250.00 share capital and PHP 50.00 savings. Total PHP 300.00. Please pay at the ACIFAC office.');
  assert.equal(meetingDuesMessage('Monthly Meeting', '2026-11-21', [{ kind: 'share_capital', cents: 25000 }, { kind: 'savings', cents: 5000 }, { kind: 'absence_fine', cents: 25000 }]),
    'For "Monthly Meeting" on November 21, 2026: PHP 250.00 share capital and PHP 50.00 savings, and a PHP 250.00 fine for missing it without a valid reason. Total PHP 550.00. Please pay at the ACIFAC office.');
});

test('loyalty awards: good standing is attendance and loans paid on time', async () => {
  const { loyaltyStanding, loyaltyAwardName } = await import('../src/services/membershipRules.js');
  assert.deepEqual(loyaltyStanding({ eligible: 0, attended: 0 }), { goodStanding: true, attendanceRate: null, attended: 0, eligible: 0, latePayments: 0, overdueLoans: 0, reasons: [] }, 'nothing to attend holds no one back');
  assert.equal(loyaltyStanding({ eligible: 4, attended: 3 }).goodStanding, true, '75% is enough');
  assert.deepEqual(loyaltyStanding({ eligible: 3, attended: 2 }).reasons, ['Attended 2 of 3 activities (66.7%, 75% needed)']);
  assert.equal(loyaltyStanding({ eligible: 3, attended: 2 }, 60).goodStanding, true);
  assert.deepEqual(loyaltyStanding({ eligible: 2, attended: 2, latePayments: 2, overdueLoans: 1 }).reasons, ['2 late loan payments', 'A loan is overdue']);
  assert.deepEqual(loyaltyStanding({ overdueLoans: 2 }).reasons, ['2 loans are overdue']);
  assert.deepEqual([3, 5, 10, 15, 20].map(loyaltyAwardName), [null, '5-Year Loyalty Award', '10-Year Loyalty Award', '15-Year Loyalty Award', 'loyalty award']);
});
