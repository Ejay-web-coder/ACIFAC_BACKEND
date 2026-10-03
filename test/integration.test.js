// End-to-end API tests against a real PostgreSQL database.
// Run with TEST_DATABASE_URL pointing at a disposable database that has had
// `npm run migrate` applied, e.g.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5433/acifac_test npm test
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = !TEST_DB && 'TEST_DATABASE_URL not set';

let baseUrl;
let server;
let stubServer;
let stubMode = 'ok';
const DEFAULT_STUB_ANALYSIS = { documentType: 'Payment Receipt', confidence: 92, ocrText: 'Receipt 123', extractedData: { 'Member Name': 'Juan Dela Cruz', 'Payment Amount': '500.00' } };
let stubAnalysis = DEFAULT_STUB_ANALYSIS;
// What the stub AI answers when it is asked to read an applicant's ID or check their 2x2 picture.
let stubIdReading = {};
let stubPhotoReading = {};
const geminiCalls = [];
let pool;
const sentEmails = [];
const sentTexts = [];
let smsMode = 'ok';
const ORIGIN = 'http://localhost:5173';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

// A browser: keeps its cookies and, when given one, its own client address
// (sent as X-Forwarded-For, which the app trusts from one proxy hop).
class Client {
  constructor(ip = null) { this.cookies = new Map(); this.ip = ip; }
  get cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async request(method, url, { body, form, headers = {}, raw = false } = {}) {
    const init = { method, headers: { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest', ...(this.ip ? { 'X-Forwarded-For': this.ip } : {}), ...headers } };
    if (this.cookies.size) init.headers.Cookie = this.cookie;
    if (form) init.body = form;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const response = await fetch(`${baseUrl}${url}`, init);
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const name = pair.slice(0, pair.indexOf('=')).trim();
      const value = pair.slice(pair.indexOf('=') + 1).trim();
      const expires = attributes.map((part) => /^\s*expires=(.*)$/i.exec(part)?.[1]).find(Boolean);
      if (!value || (expires && new Date(expires) <= new Date())) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    if (raw) return response;
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, headers: response.headers };
  }
  get(url, options) { return this.request('GET', url, options); }
  post(url, body, options = {}) { return this.request('POST', url, { ...options, body }); }
  patch(url, body, options = {}) { return this.request('PATCH', url, { ...options, body }); }
  put(url, body) { return this.request('PUT', url, { body }); }
}

function memberForm(overrides = {}, file = PNG, signatures = 0) {
  const form = new FormData();
  const fields = {
    first_name: 'Juan', last_name: 'Dela Cruz', email: 'juan@example.com', phone: '09171234567', address: 'Purok 1, Amnay',
    membership_date: '2026-01-15', share_capital: '1000', farm_area_ha: '2', date_of_birth: '1980-05-20', status: 'active', ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append('idDocument', new Blob([file], { type: 'image/png' }), 'id.png');
  for (let index = 1; index <= signatures; index += 1) form.append('signatures', new Blob([PNG], { type: 'image/png' }), `signature-${index}.png`);
  return form;
}

const admin = new Client();
const member = new Client();
const state = {};

// A loan application as the form sends it: AI reads the borrower's and the
// co-maker's IDs as they are picked, then the application is posted with both
// files and the borrower's signature.
const BORROWER_ID = {
  isId: true, idType: 'PhilSys National ID', idNumber: '1111-2222-3333', name: 'JUAN DELA CRUZ', dateOfBirth: '1980-05-20', address: 'Purok 1, Amnay, Sta. Cruz',
  frontVisible: true, backVisible: true, photocopy: true, physicalCard: false, screen: false, signatureCount: 3, expired: false, issues: [],
};
const CO_MAKER_ID = { ...BORROWER_ID, idType: 'Driver\'s License', idNumber: 'D01-23-456789', name: 'PEDRO CRUZ', dateOfBirth: '1984-02-11', address: 'Purok 2, Amnay, Sta. Cruz' };
const CO_MAKER = { coMakerName: 'Pedro Cruz', coMakerAddress: 'Purok 2, Amnay', coMakerContact: '09181112222', coMakerRelationship: 'Brother' };
let idFiles = 0;
const idFile = () => { idFiles += 1; return Buffer.concat([PNG, Buffer.from([0xee, idFiles % 256, Math.floor(idFiles / 256)])]); };

async function readLoanId(client, holder, reading, file, source = 'upload') {
  stubIdReading = reading;
  const form = new FormData();
  form.append('holder', holder);
  form.append('source', source);
  form.append('idDocument', new Blob([file], { type: 'image/png' }), `${holder}-id.png`);
  return client.request('POST', '/api/loans/id-reading', { form });
}

async function applyWithIds(client, url, application, { borrower = BORROWER_ID, coMaker = CO_MAKER_ID, acknowledgeIdWarnings = false, swapFile = false, signed = true } = {}) {
  const form = new FormData();
  form.append('application', JSON.stringify({ ...CO_MAKER, ...application }));
  for (const [holder, reading] of [['borrower', borrower], ['coMaker', coMaker]]) {
    if (!reading) continue;
    const file = idFile();
    const read = await readLoanId(client, holder, reading, file);
    assert.equal(read.status, 201, JSON.stringify(read.data));
    form.append(`${holder}IdReading`, String(read.data.readingId));
    form.append(`${holder}Id`, new Blob([swapFile ? idFile() : file], { type: 'image/png' }), `${holder}-id.png`);
  }
  if (signed) form.append('borrowerSignature', new Blob([PNG], { type: 'image/png' }), 'borrower-signature.png');
  if (acknowledgeIdWarnings) form.append('acknowledgeIdWarnings', 'true');
  return client.request('POST', url, { form });
}

// Emails are sent after the response; waits for one to arrive.
async function waitForMail(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentEmails.findLast(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Expected email was not sent.');
}

async function waitForText(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentTexts.findLast(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Expected text message was not sent.');
}

// The code in the newest reset email to `to` that is not in `seen`.
async function nextResetCode(to, seen = new Set()) {
  const mail = await waitForMail((entry) => entry.to === to && entry.subject === 'ACIFAC Password Reset' && !seen.has(/\b(\d{6})\b/.exec(entry.text)?.[1]));
  const code = /\b(\d{6})\b/.exec(mail.text)[1];
  seen.add(code);
  return { code, mail };
}

async function createLoginUser(username, email, password) {
  const { hashPassword } = await import('../src/utils/password.js');
  const result = await pool.query(
    `INSERT INTO users (username, email, password_hash, role, account_status, must_change_password) VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE', FALSE) RETURNING id`,
    [username, email, await hashPassword(password)]
  );
  return result.rows[0].id;
}

before(async () => {
  if (skip) return;
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'acifac-docs-'));
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, DATABASE_SSL: 'disable', NODE_ENV: 'test', CORS_ORIGIN: ORIGIN, FRONTEND_URL: ORIGIN,
    MEMBER_DOCUMENT_DIR: docs, OCR_AI_API_KEY: 'test-key', API_RATE_LIMIT_PER_MINUTE: '100000', EMAIL_FROM: 'test@acifac.local',
    // Small enough for the per-address lockout test to reach.
    LOGIN_IP_MAX_FAILURES: '6',
  });
  // Blank (not delete): src/config/env.js loads .env with dotenv, which only
  // fills variables that are unset, and .env points at the real services.
  Object.assign(process.env, { GEMINI_API_KEY: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_DB_URL: TEST_DB, SUPABASE_DB_LISTEN_URL: TEST_DB });

  stubServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const textbee = /^\/textbee\/gateway\/devices\/([^/]+)\/send-sms$/.exec(req.url);
      if (textbee) {
        if (smsMode === 'fail') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"device offline"}'); return; }
        sentTexts.push({ device: textbee[1], apiKey: req.headers['x-api-key'], ...JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { success: true, smsBatchId: `batch-${sentTexts.length}` } }));
        return;
      }
      const gemini = /\/gemini\/models\/([^:]+):generateContent/.exec(req.url);
      if (gemini) {
        geminiCalls.push(gemini[1]);
        const reply = { 'gemini-2.5-flash': [404, { error: { message: 'no longer available' } }], 'gemini-3.8-flash': [503, { error: { message: 'high demand' } }] }[gemini[1]];
        res.writeHead(reply ? reply[0] : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply ? reply[1] : { candidates: [{ content: { parts: [{ text: JSON.stringify(DEFAULT_STUB_ANALYSIS) }] } }] }));
        return;
      }
      if (stubMode === 'fail') { res.writeHead(500); res.end('{}'); return; }
      const prompt = String(JSON.parse(Buffer.concat(chunks).toString() || '{}').messages?.[0]?.content || '');
      const answer = prompt.startsWith('You check the valid ID that') ? stubIdReading : prompt.includes('2x2 ID picture that an applicant submits') ? stubPhotoReading : stubAnalysis;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  }).listen(0);
  process.env.OCR_AI_URL = `http://127.0.0.1:${stubServer.address().port}/v1/chat/completions`;
  // Texts go to the stub, at any hour and without the pause between them.
  Object.assign(process.env, {
    TEXTBEE_API_URL: `http://127.0.0.1:${stubServer.address().port}/textbee`, TEXTBEE_API_KEY: 'test-textbee-key', TEXTBEE_DEVICE_ID: 'test-device',
    SMS_SEND_HOURS: '0-24', SMS_SEND_GAP_MS: '0',
  });

  const { createApp } = await import('../src/app.js');
  const { getPool } = await import('../src/config/db.js');
  const { setEmailTransportForTesting } = await import('../src/services/emailService.js');
  const { startEventListener } = await import('../src/services/events.js');
  const { hashPassword } = await import('../src/utils/password.js');
  setEmailTransportForTesting({ sendMail: async (mail) => { sentEmails.push(mail); } });
  pool = getPool();
  await pool.query(`INSERT INTO users (username, email, password_hash, role, account_status, must_change_password)
                    VALUES ('testadmin', 'admin@acifac.local', $1, 'ADMIN', 'ACTIVE', FALSE)`, [await hashPassword('AdminPass1!')]);
  startEventListener();
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  if (skip) return;
  const { stopEventListener } = await import('../src/services/events.js');
  await stopEventListener();
  server?.close();
  stubServer?.close();
  await pool?.end();
});

test('auth: admin login, CSRF protection and /me', { skip }, async () => {
  const bad = await admin.post('/api/auth/login', { usernameOrEmail: 'testadmin', password: 'wrong' });
  assert.equal(bad.status, 401);
  const login = await admin.post('/api/auth/login', { usernameOrEmail: 'ADMIN@acifac.local', password: 'AdminPass1!' });
  assert.equal(login.status, 200);
  assert.equal(login.data.role, 'ADMIN');
  const me = await admin.get('/api/auth/me');
  assert.equal(me.data.user.username, 'testadmin');
  assert.equal(me.data.user.email, 'admin@acifac.local');

  const noHeader = await fetch(`${baseUrl}/api/members/savings`, { method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const evilOrigin = await admin.post('/api/members/savings', {}, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evilOrigin.status, 403);
});

test('members: create, validate, duplicate, view document, update, archive, restore', { skip }, async () => {
  const invalidFile = await admin.request('POST', '/api/members', { form: memberForm({}, Buffer.from('not an image')) });
  assert.equal(invalidFile.status, 400);
  const created = await admin.request('POST', '/api/members', { form: memberForm({}, PNG, 3) });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  state.memberId = created.data.data.id;
  assert.equal(created.data.data.signature_count, 3);
  assert.match(created.data.data.member_number, /^ACIFAC-\d{4}-001$/);
  assert.equal(created.data.data.share_capital, 1000);

  const duplicate = await admin.request('POST', '/api/members', { form: memberForm({ email: 'JUAN@example.com' }) });
  assert.equal(duplicate.status, 409);

  const second = await admin.request('POST', '/api/members', { form: memberForm({ first_name: 'Maria', last_name: 'Santos', email: 'maria@example.com', date_of_birth: '1985-01-01', share_capital: '0' }) });
  assert.equal(second.status, 201);
  state.secondMemberId = second.data.data.id;

  const list = await admin.get('/api/members?search=dela%20cruz');
  assert.equal(list.data.data.length, 1);
  const stats = await admin.get('/api/members/statistics');
  assert.equal(stats.data.data.totalMembers, 2);
  assert.equal(stats.data.data.totalShareCapital, 1000);

  const doc = await admin.request('GET', `/api/members/${state.memberId}/documents/id-document`, { raw: true });
  assert.equal(doc.status, 200);
  assert.deepEqual(Buffer.from(await doc.arrayBuffer()), PNG);
  const signature = await admin.request('GET', `/api/members/${state.memberId}/documents/signature-3`, { raw: true });
  assert.equal(signature.status, 200);
  assert.deepEqual(Buffer.from(await signature.arrayBuffer()), PNG);
  const noSignature = await admin.request('GET', `/api/members/${state.secondMemberId}/documents/signature-1`, { raw: true });
  assert.equal(noSignature.status, 404);

  // Edit Member replaces single files; the rest are kept.
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const replaceForm = new FormData();
  replaceForm.append('signature2', new Blob([JPEG], { type: 'image/jpeg' }), 'signature-2.jpg');
  const replacedDocs = await admin.request('POST', `/api/members/${state.memberId}/documents`, { form: replaceForm });
  assert.equal(replacedDocs.status, 200, JSON.stringify(replacedDocs.data));
  assert.equal(replacedDocs.data.data.signature_count, 3);
  const newSignature = await admin.request('GET', `/api/members/${state.memberId}/documents/signature-2`, { raw: true });
  assert.deepEqual(Buffer.from(await newSignature.arrayBuffer()), JPEG);
  const keptSignature = await admin.request('GET', `/api/members/${state.memberId}/documents/signature-3`, { raw: true });
  assert.deepEqual(Buffer.from(await keptSignature.arrayBuffer()), PNG);
  // A member without signatures gets them in order.
  const firstForm = new FormData();
  firstForm.append('signature3', new Blob([PNG], { type: 'image/png' }), 's.png');
  firstForm.append('idDocument', new Blob([JPEG], { type: 'image/jpeg' }), 'new-id.jpg');
  const firstSignature = await admin.request('POST', `/api/members/${state.secondMemberId}/documents`, { form: firstForm });
  assert.equal(firstSignature.status, 200);
  assert.equal(firstSignature.data.data.signature_count, 1);
  assert.equal(firstSignature.data.data.id_document_name, 'new-id.jpg');
  const empty = await admin.request('POST', `/api/members/${state.memberId}/documents`, { form: new FormData() });
  assert.equal(empty.status, 400);

  const detail = await admin.get(`/api/members/${state.memberId}`);
  const updated = await admin.put(`/api/members/${state.memberId}`, { ...detail.data.data, phone: '09179999999', membership_date: detail.data.data.membership_date });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.data.phone, '09179999999');
  assert.equal(updated.data.data.share_capital, 1000);

  // Add Member details without their own column are kept in additional_info.
  const { additional_info: _unused, ...editable } = updated.data.data;
  const withInfo = await admin.put(`/api/members/${state.memberId}`, { ...editable, additional_info: {
    motherMaidenName: 'Santos', children: [{ name: 'Ana', age: '7' }, { name: '', age: '' }], incomeSources: [{ source: 'Rice', amount: '50000' }],
    membershipType: 'Regular', orNumber: 'OR-9', notAllowed: 'dropped',
  } });
  assert.equal(withInfo.status, 200, JSON.stringify(withInfo.data));
  assert.equal(withInfo.data.data.additional_info.motherMaidenName, 'Santos');
  assert.deepEqual(withInfo.data.data.additional_info.children, [{ name: 'Ana', age: '7' }]);
  assert.equal(withInfo.data.data.additional_info.notAllowed, undefined);
  const keepsInfo = await admin.put(`/api/members/${state.memberId}`, { ...editable, phone: '09178888888' });
  assert.equal(keepsInfo.data.data.additional_info.orNumber, 'OR-9', 'an update without additional_info keeps it');

  const archived = await admin.patch(`/api/members/${state.secondMemberId}/archive`);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  const archivedList = await admin.get('/api/members/archived');
  assert.equal(archivedList.data.data[0].archived_by_username, 'testadmin');
  const again = await admin.patch(`/api/members/${state.secondMemberId}/archive`);
  assert.equal(again.status, 409);
  const restored = await admin.patch(`/api/members/${state.secondMemberId}/restore`);
  assert.equal(restored.status, 200);

  const audit = await admin.get('/api/admin/audit-logs?module=Members');
  const actions = audit.data.data.map((row) => row.action);
  for (const action of ['MEMBER_CREATED', 'MEMBER_UPDATED', 'MEMBER_ARCHIVED', 'MEMBER_RESTORED']) assert.ok(actions.includes(action), action);
});

test('accounts: create member login, setup link, forced password change', { skip }, async () => {
  const created = await admin.post('/api/admin/accounts', { memberId: state.memberId, username: 'juan', password: 'TempPass1!', confirmPassword: 'TempPass1!' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  state.memberUserId = created.data.user.id;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const setupMail = sentEmails.find((mail) => mail.to === 'juan@example.com' && /account is ready/i.test(mail.subject));
  assert.ok(setupMail, 'setup email sent');
  assert.match(setupMail.text, /http:\/\/localhost:5173\/reset-password\?token=[a-f0-9]{64}/);

  const login = await member.post('/api/auth/login', { usernameOrEmail: 'juan', password: 'TempPass1!' });
  assert.equal(login.data.mustChangePassword, true);
  const blocked = await member.get('/api/members/me');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');

  const token = /token=([a-f0-9]{64})/.exec(setupMail.text)[1];
  const reset = await new Client().post('/api/auth/reset-password', { token, newPassword: 'MemberPass1!', confirmPassword: 'MemberPass1!' });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  const oldSession = await member.get('/api/auth/me');
  assert.equal(oldSession.status, 401, 'reset revokes existing sessions');
  const reused = await new Client().post('/api/auth/reset-password', { token, newPassword: 'MemberPass2!', confirmPassword: 'MemberPass2!' });
  assert.equal(reused.status, 400, 'token is single-use');
  const relogin = await member.post('/api/auth/login', { usernameOrEmail: 'juan', password: 'MemberPass1!' });
  assert.equal(relogin.status, 200);
  assert.equal(relogin.data.mustChangePassword, false);
});

test('authorization: members cannot read other members or admin data', { skip }, async () => {
  const memberUpload = await member.request('POST', `/api/members/${state.secondMemberId}/documents`, { form: new FormData() });
  assert.equal(memberUpload.status, 403);
  for (const url of ['/api/members', '/api/members/statistics', '/api/members/archived', '/api/members/savings', `/api/members/${state.secondMemberId}`, `/api/members/${state.secondMemberId}/documents/id-document`, '/api/admin/loans', '/api/admin/accounts', '/api/kadiwa', '/api/ocr', '/api/machinery']) {
    const response = await member.get(url);
    assert.equal(response.status, 403, url);
  }
  const own = await member.get('/api/members/me');
  assert.equal(own.status, 200);
  assert.equal(own.data.data.member.id, state.memberId);
  const ownDoc = await member.request('GET', '/api/members/me/documents/id-document', { raw: true });
  assert.equal(ownDoc.status, 200);
  const anonymous = await new Client().get('/api/members/me');
  assert.equal(anonymous.status, 401);
});

test('savings deposits and share capital are separate ledgers', { skip }, async () => {
  const saved = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '2500.50', date: '2026-02-01', paymentMethod: 'Deposit', reference: 'OR-1001' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.memberTotal, 2500.5);
  const duplicate = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '10', date: '2026-02-01', reference: 'or-1001' });
  assert.equal(duplicate.status, 409);
  const large = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '30000', date: '2026-02-02' });
  assert.equal(large.status, 201, 'savings are not limited by the share capital cap');
  const badAmount = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '-5', date: '2026-02-02' });
  assert.equal(badAmount.status, 400);
  const future = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '5', date: '2999-01-01' });
  assert.equal(future.status, 400);
  const list = await admin.get('/api/members/savings');
  assert.equal(list.data.summary.totalAmount, 32500.5);
  assert.equal(list.data.data.length, 2);

  const share = await admin.post(`/api/members/${state.memberId}/share-contributions`, { amount: '500', contributionDate: '2026-02-03', referenceNumber: 'SC-1' });
  assert.equal(share.status, 201, JSON.stringify(share.data));
  assert.equal(share.data.data.total, 1500);
  const overCap = await admin.post(`/api/members/${state.memberId}/share-contributions`, { amount: '18600', contributionDate: '2026-02-03' });
  assert.equal(overCap.status, 400);

  const mine = await member.get('/api/members/me');
  assert.equal(mine.data.data.savings.total, 32500.5);
  assert.equal(mine.data.data.shareDetails.total, 1500);
  assert.equal(mine.data.data.member.share_capital, 1500);
});

test('loans: quote, apply, approve, installments, payments, overdue, paid', { skip }, async () => {
  const quote = await member.post('/api/loans/quote', { farmArea: '2', amount: '50000', term: 12 });
  assert.deepEqual([quote.data.quote.maximumEligibleAmount, quote.data.quote.calculatedInterest, quote.data.quote.totalRepayment, quote.data.quote.monthlyPayment], ['100000.00', '1250.00', '51250.00', '4270.83']);

  const tooMuch = await applyWithIds(member, '/api/members/me/loan-requests', { loanType: 'agricultural', amount: '150000', term: 12, purpose: 'Seeds', farmArea: '2' });
  assert.equal(tooMuch.status, 400);
  const applied = await applyWithIds(member, '/api/members/me/loan-requests', { loanType: 'agricultural', amount: '50000', term: 12, purpose: 'Rice seeds and fertilizer', farmArea: '2', totalRepayment: '1' });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal(applied.data.request.totalRepayment, '51250.00', 'client-sent totals are ignored');
  const twice = await applyWithIds(member, '/api/members/me/loan-requests', { loanType: 'agricultural', amount: '1000', term: 12, purpose: 'x', farmArea: '2' });
  assert.equal(twice.status, 409);

  const adminNotes = await admin.get('/api/notifications');
  assert.ok(adminNotes.data.data.some((n) => n.type === 'loan_submitted'));

  const approve = await admin.patch(`/api/admin/loan-requests/${applied.data.request.id}`, { status: 'approved' });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));
  state.loanId = approve.data.loanId;
  const detail = await admin.get(`/api/admin/loans/${state.loanId}`);
  assert.equal(detail.data.loan.totalAmount, '51250.00');
  assert.equal(detail.data.loan.balance, '51250.00');
  assert.equal(detail.data.installments.length, 12);
  const scheduleTotal = detail.data.installments.reduce((sum, row) => sum + Math.round(Number(row.amountDue) * 100), 0);
  assert.equal(scheduleTotal, 5125000);
  assert.match(detail.data.loan.id, /^L-\d{4}-\d{3}$/);

  const future = await admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: '100', paymentDate: '2999-01-01' });
  assert.equal(future.status, 400);
  const over = await admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: '60000', paymentDate: detail.data.loan.dateApproved });
  assert.equal(over.status, 400);
  const pay = await admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: '4270.83', paymentDate: detail.data.loan.dateApproved });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  assert.equal(pay.data.payment.interestPaid, '104.16');
  assert.equal(pay.data.payment.principalPaid, '4166.67');
  assert.equal(pay.data.payment.remainingBalance, '46979.17');

  // Simulate time passing: move the loan 3 months into the past.
  await pool.query(`UPDATE loans SET date_approved = date_approved - 90 WHERE id = $1`, [state.loanId]);
  await pool.query(`UPDATE loan_installments SET due_date = due_date - 90 WHERE loan_id = $1`, [state.loanId]);
  const { refreshLoanStatuses } = await import('../src/services/loanService.js');
  await refreshLoanStatuses({ force: true });
  await refreshLoanStatuses({ force: true });
  const overdue = await admin.get(`/api/admin/loans/${state.loanId}`);
  assert.equal(overdue.data.loan.status, 'overdue');
  assert.ok(Number(overdue.data.loan.overdueAmount) > 0);
  const overdueNotes = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'payment_overdue' AND user_id = $1`, [state.memberUserId]);
  assert.equal(overdueNotes.rows[0].n, overdue.data.loan.overdueInstallments, 'one notification per overdue installment, no duplicates');
  const overdueMail = sentEmails.filter((mail) => /Loan payment overdue/.test(mail.subject));
  assert.equal(overdueMail.length, overdue.data.loan.overdueInstallments, 'one overdue email per installment, none repeated by the second refresh');
  // The same reminders are texted, once each, to the mobile number on the member record.
  const { flushSmsOutbox } = await import('../src/services/smsService.js');
  await flushSmsOutbox();
  const overdueTexts = sentTexts.filter((text) => /is now overdue\. Please pay at the ACIFAC office\.\n- ACIFAC Administrator$/.test(text.message));
  assert.equal(overdueTexts.length, overdue.data.loan.overdueInstallments, 'one overdue text per installment');
  for (const text of overdueTexts) {
    assert.deepEqual([text.recipients, text.device, text.apiKey], [['+639178888888'], 'test-device', 'test-textbee-key']);
    assert.ok(text.message.startsWith('Installment ') && text.message.length <= 160, text.message);
  }
  const outbox = await pool.query(`SELECT status, COUNT(*)::int AS n FROM sms_outbox GROUP BY status`);
  assert.deepEqual(outbox.rows, [{ status: 'sent', n: sentTexts.length }]);

  const rest = await admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: overdue.data.loan.balance, paymentDate: overdue.data.loan.dateApproved });
  assert.equal(rest.status, 201, JSON.stringify(rest.data));
  const paid = await admin.get(`/api/admin/loans/${state.loanId}`);
  assert.equal(paid.data.loan.status, 'paid');
  assert.equal(paid.data.loan.balance, '0.00');
  assert.equal(paid.data.loan.totalPaid, '51250.00');
  assert.equal(paid.data.loan.nextPaymentDate, null);

  const mine = await member.get('/api/members/me');
  assert.equal(mine.data.data.loans[0].status, 'paid');
  assert.equal(mine.data.data.payments.length, 2);

  const declined = await applyWithIds(member, '/api/members/me/loan-requests', { loanType: 'emergency', amount: '1000', term: 3, purpose: 'Repair', farmArea: '2' });
  const decline = await admin.patch(`/api/admin/loan-requests/${declined.data.request.id}`, { status: 'declined', reason: 'Incomplete documents' });

  // The paper-form layout sends the cash amount; the server adds the farm inputs to it.
  const paper = { loanType: 'agricultural', term: 12, farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay', cropsPlanted: 'Palay', certified: true };
  const noCash = await applyWithIds(member, '/api/members/me/loan-requests', { ...paper, loanMode: 'cash', cashAmount: '' });
  assert.equal(noCash.status, 400);
  const combined = await applyWithIds(member, '/api/members/me/loan-requests', {
    ...paper, loanMode: 'combination', cashAmount: '10000', amount: '1',
    inKindItems: [{ item: 'Fertilizer', description: 'Urea', quantity: '10', unit: 'bags', unitPrice: '1500' }, { item: 'Seeds', quantity: '2.5', unit: 'bags', unitPrice: '1000.10' }],
  });
  assert.equal(combined.status, 201, JSON.stringify(combined.data));
  assert.equal(combined.data.request.amount, '27500.25', 'cash 10,000 + fertilizer 15,000 + seeds 2,500.25');
  assert.equal(combined.data.request.purpose, 'Agricultural loan for Palay (combination).');
  assert.equal(combined.data.request.inKindItems.length, 2);
  await admin.patch(`/api/admin/loan-requests/${combined.data.request.id}`, { status: 'declined', reason: 'test cleanup' });
  assert.equal(decline.status, 200);
  const memberNotes = await member.get('/api/notifications');
  assert.ok(memberNotes.data.data.some((n) => n.type === 'loan_declined' && /Incomplete documents/.test(n.message)));
});

test('sms: a text the phone gateway refuses is retried later; members can switch SMS off', { skip }, async () => {
  const { flushSmsOutbox, queueSmsForUsers } = await import('../src/services/smsService.js');
  const textsBefore = sentTexts.length;
  const row = async () => (await pool.query(`SELECT status, attempts, last_error, retry_at > NOW() AS waiting FROM sms_outbox WHERE message = 'ACIFAC: retry test'`)).rows[0];

  smsMode = 'fail';
  assert.equal(await queueSmsForUsers([{ user_id: state.memberUserId }], () => 'ACIFAC: retry test'), 1);
  assert.equal(await flushSmsOutbox(), 0);
  const failed = await row();
  assert.deepEqual([failed.status, failed.attempts, failed.waiting], ['pending', 1, true]);
  assert.match(failed.last_error, /503/);

  smsMode = 'ok';
  assert.equal(await flushSmsOutbox(), 0, 'not retried before retry_at');
  await pool.query(`UPDATE sms_outbox SET retry_at = NOW() WHERE message = 'ACIFAC: retry test'`);
  assert.equal(await flushSmsOutbox(), 1);
  assert.deepEqual([(await row()).status, (await row()).attempts], ['sent', 2]);
  assert.equal(sentTexts.length, textsBefore + 1);

  const off = await member.patch('/api/auth/notification-preferences', { emailNotifications: true, smsNotifications: false, loanReminders: true });
  assert.equal(off.data.preferences.smsNotifications, false);
  assert.equal(await queueSmsForUsers([{ user_id: state.memberUserId }], () => 'ACIFAC: switched off'), 0);
  const on = await member.patch('/api/auth/notification-preferences', { emailNotifications: true, loanReminders: true });
  assert.equal(on.data.preferences.smsNotifications, true, 'SMS is on unless switched off');
});

test('machinery: catalogue, request, approve, overlap protection, member status', { skip }, async () => {
  const catalog = await member.get('/api/machinery/catalog');
  assert.ok(catalog.data.machinery.length >= 1);
  const machine = catalog.data.machinery.find((row) => row.status !== 'maintenance');
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const today = todayDateOnly();
  const plus = (days) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  const request = await member.post('/api/machinery/requests', { machineryId: machine.id, startDate: plus(1), endDate: plus(3), purpose: 'Land preparation' });
  assert.equal(request.status, 201, JSON.stringify(request.data));
  assert.equal(Number(request.data.request.duration), 2);
  assert.equal(Number(request.data.request.rentalFee), Number(machine.dailyFee) * 2);
  const other = await admin.post('/api/machinery/requests', { machineryId: machine.id, memberDatabaseId: state.secondMemberId, startDate: plus(2), endDate: plus(4), purpose: 'Hauling' });
  assert.equal(other.status, 201);

  assert.equal((await admin.patch(`/api/machinery/requests/${request.data.request.id}`, { status: 'approved' })).status, 200);
  const overlap = await admin.patch(`/api/machinery/requests/${other.data.request.id}`, { status: 'approved' });
  assert.equal(overlap.status, 409);
  const booked = await member.post('/api/machinery/requests', { machineryId: machine.id, startDate: plus(2), endDate: plus(2), purpose: 'x' });
  assert.equal(booked.status, 409);

  const mine = await member.get('/api/members/me');
  assert.equal(mine.data.data.rentalRequests[0].status, 'approved');
  assert.equal(mine.data.data.rentalRequests[0].operationStatus, 'scheduled');

  const created = await admin.post('/api/machinery', { name: 'Combine Harvester', type: 'Harvester', dailyFee: '1500', acquisitionDate: '2026-01-10' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const maintenance = await admin.patch(`/api/machinery/${created.data.machinery.id}`, { status: 'maintenance' });
  assert.equal(maintenance.data.machinery.status, 'maintenance');
  const blocked = await member.post('/api/machinery/requests', { machineryId: created.data.machinery.id, startDate: plus(1), endDate: plus(1), purpose: 'x' });
  assert.equal(blocked.status, 409);
});

test('machinery services: dated rates, fees, payments, expenses and the PhilMech report', { skip }, async () => {
  // Seeded by sql/017: per-service machines stay out of the per-day booking.
  const fleet = (await admin.get('/api/machinery')).data.machinery;
  const tractor = fleet.find((row) => row.name === 'Tractor with Rotavator');
  const harvester = fleet.find((row) => row.name === 'Harvester' && row.pricingMode === 'per_service');
  assert.equal(tractor.pricingMode, 'per_service');
  assert.equal(tractor.deliveryDate, '2025-02-21');
  assert.equal(tractor.condition, 'always_repair');
  assert.equal(harvester.deliveryDate, '2020-12-08');
  assert.equal(fleet.find((row) => row.id === 'M-004').parentMachineryId, tractor.id);
  const catalog = (await member.get('/api/machinery/catalog')).data.machinery;
  assert.ok(catalog.every((row) => row.id !== tractor.id && row.id !== harvester.id));
  assert.ok(catalog.some((row) => row.id === 'M-003'), 'per-day machines such as the Water Pump are still bookable');
  const perDay = await member.post('/api/machinery/requests', { machineryId: tractor.id, startDate: '2099-01-01', endDate: '2099-01-02', purpose: 'Plowing' });
  assert.equal(perDay.status, 409);
  assert.match(perDay.data.message, /paid per service/);
  assert.equal((await member.get('/api/machinery/services')).status, 403);

  // The report's member cases use the registered test member (the fee does not depend on the name).
  const galopeId = state.memberId;

  const quote = await admin.post('/api/machinery/services/quote', { machineryId: tractor.id, serviceType: 'rotavator', serviceDate: '2026-06-10', clientCategory: 'member', areaHa: '1.5' });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.quote.feeAmount, '5700.00');
  const early = await admin.post('/api/machinery/services/quote', { machineryId: tractor.id, serviceType: 'Squadrone', serviceDate: '2026-03-15', clientCategory: 'member', areaHa: '1' });
  assert.equal(early.status, 400);
  assert.match(early.data.message, /No Squadrone rate/);

  const base = { machineryId: tractor.id, croppingPeriod: '1st', year: 2026 };
  const rotavator = await admin.post('/api/machinery/services', { ...base, serviceType: 'Rotavator', serviceDate: '2026-06-10', clientCategory: 'member', memberDatabaseId: galopeId, areaHa: '1.5', amountPaid: '4000' });
  assert.equal(rotavator.status, 201, JSON.stringify(rotavator.data));
  assert.equal(rotavator.data.service.clientName, 'Juan Dela Cruz', 'a member\'s name and address come from the member record');
  assert.ok(rotavator.data.service.clientAddress);
  assert.equal(rotavator.data.service.feeAmount, '5700.00');
  assert.equal(rotavator.data.service.balance, '1700.00');
  assert.equal(rotavator.data.service.paymentStatus, 'partial');

  const squadrone = await admin.post('/api/machinery/services', { ...base, serviceType: 'Squadrone', serviceDate: '2026-06-11', clientCategory: 'non_member', clientName: 'Eleseo Acosta', clientAddress: 'Calintaan', areaHa: '1', amountPaid: '2000' });
  assert.equal(squadrone.status, 201, JSON.stringify(squadrone.data));
  assert.equal(squadrone.data.service.feeAmount, '3400.00');
  assert.equal(squadrone.data.service.balance, '1400.00');
  assert.equal(squadrone.data.service.memberDatabaseId, null);

  const harvestBase = { machineryId: harvester.id, serviceType: 'Harvesting', serviceDate: '2026-05-05', croppingPeriod: '1st', year: 2026, totalBags: '100', bagValue: '1000' };
  const memberHarvest = await admin.post('/api/machinery/services', { ...harvestBase, clientCategory: 'member', memberDatabaseId: galopeId, areaHa: '2' });
  const guestHarvest = await admin.post('/api/machinery/services', { ...harvestBase, clientCategory: 'non_member', clientName: 'Rosa Reyes', kgPerBag: '50', pricePerKg: '14', bagValue: '' });
  assert.equal(memberHarvest.status, 201, JSON.stringify(memberHarvest.data));
  assert.equal(memberHarvest.data.service.feeBags, '10.00');
  assert.equal(memberHarvest.data.service.feeAmount, '10000.00');
  assert.equal(guestHarvest.data.service.feeBags, '12.00');
  assert.equal(guestHarvest.data.service.bagValue, '700.00');
  assert.equal(guestHarvest.data.service.feeAmount, '8400.00');

  // A changed fee needs a reason and keeps the fee from the rate.
  const tudling = { ...base, serviceType: 'Tudling', serviceDate: '2026-06-12', clientCategory: 'non_member', clientName: 'Pedro Santos', areaHa: '1', feeAmount: '1500' };
  assert.equal((await admin.post('/api/machinery/services', tudling)).status, 400);
  const discounted = await admin.post('/api/machinery/services', { ...tudling, feeOverrideReason: 'Board-approved discount' });
  assert.equal(discounted.status, 201, JSON.stringify(discounted.data));
  assert.equal(discounted.data.service.computedFeeAmount, '1800.00');
  assert.equal(discounted.data.service.feeAmount, '1500.00');
  assert.equal(discounted.data.service.paymentStatus, 'unpaid');

  const serviceId = rotavator.data.service.id;
  const over = await admin.post(`/api/machinery/services/${serviceId}/payments`, { amount: '1700.01', paymentDate: '2026-06-20' });
  assert.equal(over.status, 400);
  const paid = await admin.post(`/api/machinery/services/${serviceId}/payments`, { amount: '1700', paymentDate: '2026-06-20' });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.equal(paid.data.service.paymentStatus, 'full');
  assert.equal(paid.data.payments.length, 2);
  const voided = await admin.request('DELETE', `/api/machinery/services/${serviceId}/payments/${paid.data.payments[1].id}`);
  assert.equal(voided.data.service.balance, '1700.00');
  assert.equal((await admin.request('DELETE', `/api/machinery/services/${serviceId}`)).status, 409, 'services with payments are not deleted');
  const lowered = await admin.patch(`/api/machinery/services/${serviceId}`, { ...base, serviceType: 'Rotavator', serviceDate: '2026-06-10', clientCategory: 'member', memberDatabaseId: galopeId, areaHa: '1' });
  assert.equal(lowered.status, 409, 'the fee cannot drop below what was collected');

  // A new open-ended rate ends the previous one the day before.
  const newRate = await admin.post(`/api/machinery/${tractor.id}/rates`, { serviceType: 'tudling', unit: 'per_ha', memberRate: '2000', nonMemberRate: '2200', effectiveFrom: '2026-07-01' });
  assert.equal(newRate.status, 201, JSON.stringify(newRate.data));
  const rates = (await admin.get(`/api/machinery/${tractor.id}/rates`)).data.rates.filter((rate) => rate.serviceType === 'Tudling');
  assert.deepEqual(rates.map((rate) => [rate.effectiveFrom, rate.effectiveTo, rate.memberRate]), [['2026-01-01', '2026-06-30', '1800.00'], ['2026-07-01', null, '2000.00']]);
  const julyQuote = await admin.post('/api/machinery/services/quote', { machineryId: tractor.id, serviceType: 'Tudling', serviceDate: '2026-07-02', clientCategory: 'non_member', areaHa: '1' });
  assert.equal(julyQuote.data.quote.feeAmount, '2200.00');
  assert.equal((await admin.post(`/api/machinery/${tractor.id}/rates`, { serviceType: 'Tudling', unit: 'per_ha', memberRate: '1', nonMemberRate: '1', effectiveFrom: '2026-06-01', effectiveTo: '2026-06-10' })).status, 409);
  assert.equal((await admin.request('DELETE', `/api/machinery/rates/${rates[0].id}`)).status, 409, 'a rate used by a service is ended, not deleted');

  const fuel = await admin.post('/api/machinery/expenses', { machineryId: tractor.id, expenseDate: '2026-06-01', croppingPeriod: '1st', year: 2026, category: 'fuel', amount: '2500', description: 'Diesel' });
  assert.equal(fuel.status, 201, JSON.stringify(fuel.data));
  await admin.post('/api/machinery/expenses', { machineryId: 'M-004', expenseDate: '2026-06-05', croppingPeriod: '1st', year: 2026, category: 'repair_maintenance', amount: '3000', description: 'Rotavator blades' });
  const late = await admin.post('/api/machinery/expenses', { machineryId: tractor.id, expenseDate: '2026-08-15', croppingPeriod: '1st', year: 2026, category: 'labor', amount: '1500' });
  const expenses = await admin.get(`/api/machinery/expenses?croppingPeriod=1st&year=2026`);
  assert.equal(expenses.data.totals.total, '7000.00');
  assert.equal((await admin.put('/api/machinery/period-balances', { machineryId: tractor.id, croppingPeriod: '1st', year: 2026, beginningCash: '10000', otherIncome: '500' })).status, 200);

  const report = await admin.get(`/api/machinery/reports/philmech?croppingPeriod=1st&year=2026&fromMonth=1&toMonth=7`);
  assert.equal(report.status, 200, JSON.stringify(report.data));
  const tractorReport = report.data.report.machines.find((row) => row.machineryId === tractor.id);
  assert.deepEqual(tractorReport.implements, [{ id: 'M-004', name: 'Rotavator' }]);
  assert.deepEqual(tractorReport.summary.farmers, { member: 1, nonMember: 2, total: 3 });
  assert.deepEqual(tractorReport.summary.areaHa, { member: '1.5000', nonMember: '2.0000', total: '3.5000' });
  assert.deepEqual(tractorReport.summary.grossIncome, { collected: '6000.00', collectibles: '4600.00', total: '10600.00' });
  assert.equal(tractorReport.summary.operatingExpenses, '7000.00');
  assert.equal(tractorReport.summary.availableFunds, '3600.00');
  assert.deepEqual(tractorReport.cashFlow.outflows, { fuel: '2500.00', labor: '1500.00', repair_maintenance: '3000.00', other: '0.00' });
  assert.equal(tractorReport.cashFlow.totalSourceOfCash, '16500.00');
  assert.equal(tractorReport.cashFlow.netCashFlow, '9500.00');
  assert.equal(tractorReport.clientTotals.accountsReceivable, '4600.00');
  assert.deepEqual(tractorReport.warnings.map((warning) => warning.code), ['EXPENSE_OUTSIDE_MONTHS', 'FEE_CHANGED', 'UNPAID_NO_PAYMENT']);
  const harvestReport = report.data.report.machines.find((row) => row.machineryId === harvester.id);
  assert.deepEqual(harvestReport.summary.bags, { member: '100.00', nonMember: '100.00', total: '200.00' });
  assert.ok(harvestReport.warnings.some((warning) => warning.code === 'SERVICE_WITHOUT_AREA'));

  assert.equal((await admin.request('DELETE', `/api/machinery/expenses/${late.data.expense.id}`)).status, 200);
  assert.equal((await admin.request('DELETE', `/api/machinery/services/${discounted.data.service.id}`)).status, 200);
  const actions = (await pool.query(`SELECT action FROM audit_logs WHERE module = 'Machinery' AND action LIKE 'MACHINERY_%' GROUP BY action ORDER BY action`)).rows.map((row) => row.action);
  for (const action of ['MACHINERY_EXPENSE_DELETED', 'MACHINERY_EXPENSE_RECORDED', 'MACHINERY_PERIOD_BALANCE_RECORDED', 'MACHINERY_RATE_ADDED', 'MACHINERY_RATE_UPDATED',
    'MACHINERY_SERVICE_DELETED', 'MACHINERY_SERVICE_PAYMENT_RECEIVED', 'MACHINERY_SERVICE_PAYMENT_VOIDED', 'MACHINERY_SERVICE_RECORDED']) {
    assert.ok(actions.includes(action), `${action} is audited`);
  }
});

test('kadiwa: sales decrement stock, reject overselling and race safely', { skip }, async () => {
  const before = await admin.get('/api/kadiwa');
  const rice = before.data.inventory.find((item) => item.id === 'INV-001');
  const startStock = Number(rice.stock);
  const sale = await admin.post('/api/kadiwa/sales', { encoderName: 'Tester', items: [{ inventoryId: 'INV-001', quantity: '5' }], totalExpenses: '10' });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(Number(sale.data.sale.groceries), 5 * Number(rice.price));
  const afterSale = await admin.get('/api/kadiwa');
  assert.equal(Number(afterSale.data.inventory.find((item) => item.id === 'INV-001').stock), startStock - 5);

  const oversell = await admin.post('/api/kadiwa/sales', { encoderName: 'Tester', items: [{ inventoryId: 'INV-001', quantity: String(startStock) }] });
  assert.equal(oversell.status, 409);

  const remaining = startStock - 5;
  const half = String(Math.floor(remaining / 2) + 1);
  const results = await Promise.all([1, 2].map(() => admin.post('/api/kadiwa/sales', { encoderName: 'Race', items: [{ inventoryId: 'INV-001', quantity: half }] })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const final = await admin.get('/api/kadiwa');
  const finalStock = Number(final.data.inventory.find((item) => item.id === 'INV-001').stock);
  assert.equal(finalStock, remaining - Number(half));
  assert.ok(finalStock >= 0);
});

test('loans: applications typed into the app need the borrower and co-maker IDs with 3 signatures', { skip }, async () => {
  const paper = { loanType: 'agricultural', loanMode: 'cash', cashAmount: '5000', term: 12, farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay', cropsPlanted: 'Palay', certified: true };
  const url = '/api/members/me/loan-requests';

  // No IDs, no co-maker, or one ID missing: refused.
  const json = await member.post(url, { ...paper, ...CO_MAKER });
  assert.equal(json.status, 422, JSON.stringify(json.data));
  assert.match(json.data.message, /Submit the borrower's valid ID/);
  const noCoMaker = await applyWithIds(member, url, { ...paper, coMakerName: '', coMakerAddress: '', coMakerContact: '', coMakerRelationship: '' });
  assert.equal(noCoMaker.status, 400);
  assert.match(noCoMaker.data.message, /co-maker's valid ID is required/);
  const borrowerOnly = await applyWithIds(member, url, paper, { coMaker: null });
  assert.equal(borrowerOnly.status, 422);
  assert.match(borrowerOnly.data.message, /Submit the co-maker's valid ID/);

  // The reading must be for the file submitted, and for the person it is submitted as.
  const swapped = await applyWithIds(member, url, paper, { swapFile: true });
  assert.equal(swapped.status, 400);
  assert.match(swapped.data.message, /not the one AI read/);
  const read = await readLoanId(member, 'coMaker', CO_MAKER_ID, idFile());
  const asBorrower = new FormData();
  asBorrower.append('application', JSON.stringify({ ...paper, ...CO_MAKER }));
  asBorrower.append('borrowerIdReading', String(read.data.readingId));
  assert.equal((await member.request('POST', url, { form: asBorrower })).status, 400);
  assert.equal((await readLoanId(member, 'spouse', BORROWER_ID, idFile())).status, 400);
  const pdf = new FormData();
  pdf.append('holder', 'borrower'); pdf.append('source', 'camera');
  pdf.append('idDocument', new Blob([Buffer.from('%PDF-1.4 id')], { type: 'application/pdf' }), 'id.pdf');
  assert.equal((await member.request('POST', '/api/loans/id-reading', { form: pdf })).status, 400);

  // Two signatures, someone else's ID, or the borrower's own ID for the co-maker: refused.
  const twoSigned = await applyWithIds(member, url, paper, { borrower: { ...BORROWER_ID, signatureCount: 2 } });
  assert.equal(twoSigned.status, 422);
  assert.match(twoSigned.data.message, /2 specimen signatures; 3 are required/);
  const stranger = await applyWithIds(member, url, paper, { borrower: { ...BORROWER_ID, name: 'MARIA SANTOS' } });
  assert.equal(stranger.status, 422);
  assert.match(stranger.data.message, /not the borrower/);
  const sameId = await applyWithIds(member, url, paper, { coMaker: BORROWER_ID });
  assert.equal(sameId.status, 422);
  assert.match(sameId.data.errors.join(' '), /borrower's name/);
  // The borrower signs on the form's Borrower Signature line, with a picture.
  const unsigned = await applyWithIds(member, url, paper, { signed: false });
  assert.equal(unsigned.status, 422);
  assert.match(unsigned.data.message, /has to sign the application/);
  const pdfSigned = new FormData();
  pdfSigned.append('application', JSON.stringify({ ...paper, ...CO_MAKER }));
  pdfSigned.append('borrowerSignature', new Blob([Buffer.from('%PDF-1.4 signature')], { type: 'application/pdf' }), 'signature.pdf');
  assert.equal((await member.request('POST', url, { form: pdfSigned })).status, 400);
  const pending = await admin.get('/api/admin/loan-requests?status=pending&limit=100');
  assert.equal(pending.data.requests.filter((r) => Number(r.memberDatabaseId) === state.memberId).length, 0, 'nothing was saved');

  // The form previews the checks before submitting.
  const borrowerRead = await readLoanId(member, 'borrower', BORROWER_ID, idFile());
  const coMakerRead = await readLoanId(member, 'coMaker', { ...CO_MAKER_ID, address: 'Poblacion, Sablayan' }, idFile());
  assert.equal(borrowerRead.data.reading.name, 'JUAN DELA CRUZ');
  const preview = await member.post('/api/loans/id-checks', { borrowerIdReading: borrowerRead.data.readingId, coMakerIdReading: coMakerRead.data.readingId, ...CO_MAKER, borrowerAddress: 'Purok 1, Amnay', borrowerAge: '46' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const previewed = Object.fromEntries(preview.data.checks.map((check) => [check.id, check.status]));
  assert.deepEqual(previewed, { idDocument: 'pass', idMatch: 'pass', coMakerId: 'pass', coMakerMatch: 'warn' });
  assert.equal((await admin.post('/api/loans/id-checks', { memberId: state.memberId, borrowerIdReading: borrowerRead.data.readingId })).status, 400, 'a reading belongs to whoever asked for it');

  // A member's application with an ID warning is sent for approval with the warning; the approver sees both IDs.
  const warned = await applyWithIds(member, url, paper, { coMaker: { ...CO_MAKER_ID, address: 'Poblacion, Sablayan' } });
  assert.equal(warned.status, 201, JSON.stringify(warned.data));
  const { idDocuments } = warned.data.request;
  assert.deepEqual(Object.keys(idDocuments).sort(), ['borrower', 'coMaker']);
  assert.equal(idDocuments.borrower.path, undefined, 'storage paths are not sent');
  assert.equal(idDocuments.borrower.reading.signatureCount, 3);
  assert.ok(idDocuments.coMaker.checks.some((check) => check.id === 'coMakerMatch' && check.status === 'warn'));
  const requestId = warned.data.request.id;
  const borrowerFile = await admin.request('GET', `/api/admin/loan-requests/${requestId}/id-documents/borrower`, { raw: true });
  assert.equal(borrowerFile.status, 200);
  assert.equal((await member.request('GET', `/api/admin/loan-requests/${requestId}/id-documents/borrower`, { raw: true })).status, 403);
  assert.equal((await admin.request('GET', `/api/admin/loan-requests/${requestId}/id-documents/spouse`, { raw: true })).status, 404);
  const { borrowerSignature } = warned.data.request;
  assert.equal(borrowerSignature.mimeType, 'image/png');
  assert.equal(borrowerSignature.path, undefined, 'storage paths are not sent');
  assert.match(borrowerSignature.signedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await admin.request('GET', `/api/admin/loan-requests/${requestId}/borrower-signature`, { raw: true })).status, 200);
  assert.equal((await member.request('GET', `/api/admin/loan-requests/${requestId}/borrower-signature`, { raw: true })).status, 403);

  // Approval keeps the IDs with the loan.
  const approved = await admin.patch(`/api/admin/loan-requests/${requestId}`, { status: 'approved' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const loan = (await admin.get(`/api/admin/loans/${approved.data.loanId}`)).data.loan;
  assert.deepEqual(Object.keys(loan.idDocuments).sort(), ['borrower', 'coMaker']);
  const loanFile = await admin.request('GET', `/api/admin/loans/${approved.data.loanId}/id-documents/coMaker`, { raw: true });
  assert.equal(loanFile.status, 200);
  assert.equal(loan.borrowerSignature.signedOn, borrowerSignature.signedOn, 'the signature goes with the loan');
  assert.equal((await admin.request('GET', `/api/admin/loans/${approved.data.loanId}/borrower-signature`, { raw: true })).status, 200);

  // An admin releasing a loan at once must confirm ID warnings.
  const direct = { ...paper, memberId: state.memberId, cashAmount: '3000' };
  const unconfirmed = await applyWithIds(admin, '/api/admin/loans', direct, { coMaker: { ...CO_MAKER_ID, address: 'Poblacion, Sablayan' } });
  assert.equal(unconfirmed.status, 422);
  assert.match(unconfirmed.data.message, /Confirm that you compared the flagged ID details/);
  const released = await applyWithIds(admin, '/api/admin/loans', direct, { coMaker: { ...CO_MAKER_ID, address: 'Poblacion, Sablayan' }, acknowledgeIdWarnings: true });
  assert.equal(released.status, 201, JSON.stringify(released.data));
  assert.deepEqual(Object.keys(released.data.loan.idDocuments).sort(), ['borrower', 'coMaker']);
  const audit = await pool.query(`SELECT new_values FROM audit_logs WHERE action = 'LOAN_CREATED' AND entity_id = $1`, [String(released.data.loan.databaseId)]);
  assert.equal(audit.rows[0].new_values.ids.borrower.signatures, 3);
  assert.equal(audit.rows[0].new_values.signed, true);
  assert.ok(released.data.loan.borrowerSignature, 'a loan released at once keeps the signature');
  // These loans are not part of the analytics test that follows.
  await pool.query('DELETE FROM loans WHERE id = ANY($1::int[])', [[approved.data.loanId, released.data.loan.databaseId]]);
});

test('ocr: upload, classify, duplicate, failure recorded and retried, review saved', { skip }, async () => {
  const form = new FormData();
  form.append('document', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
  const ok = await admin.request('POST', '/api/ocr/analyze', { form });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.data.documentType, 'Payment Receipt');
  const dup = await admin.request('POST', '/api/ocr/analyze', { form });
  assert.equal(dup.status, 409);

  stubMode = 'fail';
  const other = Buffer.concat([PNG, Buffer.from([1, 2, 3])]);
  const failForm = () => { const f = new FormData(); f.append('document', new Blob([other], { type: 'image/png' }), 'blurry.png'); return f; };
  const failed = await admin.request('POST', '/api/ocr/analyze', { form: failForm() });
  assert.equal(failed.status, 201);
  assert.equal(failed.data.data.processingStatus, 'failed');
  stubMode = 'ok';
  const retried = await admin.request('POST', '/api/ocr/analyze', { form: failForm() });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.data.processingStatus, 'completed');
  assert.equal(retried.data.data.id, failed.data.data.id);

  const review = await admin.patch(`/api/ocr/${ok.data.data.id}/review`, { documentType: 'Payment Receipt', extractedData: { 'Member Name': 'Juan Dela Cruz', 'Payment Amount': '500.00' } });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  assert.equal(review.data.data.reviewStatus, 'reviewed');
  const badReview = await admin.patch(`/api/ocr/${ok.data.data.id}/review`, { documentType: 'Payment Receipt', extractedData: { 'Payment Amount': 'lots' } });
  assert.equal(badReview.status, 400);
  const file = await admin.request('GET', `/api/ocr/${ok.data.data.id}/file`, { raw: true });
  assert.equal(file.status, 200);
});

test('ocr: scanned forms are verified, posted to their module, and fakes are blocked', { skip }, async () => {
  const memberRecord = await admin.get(`/api/members/${state.memberId}`);
  const memberNumber = memberRecord.data.data.member_number;
  const genuine = { score: 95, verdict: 'genuine', physicalDocument: true, filledIn: true, signaturePresent: true, issues: [] };
  let counter = 10;
  const scan = async (analysis, source = 'camera') => {
    stubAnalysis = analysis;
    counter += 1;
    const form = new FormData();
    form.append('source', source);
    form.append('document', new Blob([Buffer.concat([PNG, Buffer.from([counter])])], { type: 'image/png' }), `form-${counter}.png`);
    const response = await admin.request('POST', '/api/ocr/analyze', { form });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.data;
  };
  const savingsForm = (overrides = {}, authenticity = genuine) => ({
    documentType: 'Savings Form', confidence: 94, ocrText: 'ACIFAC SAVINGS DEPOSIT',
    extractedData: { memberNumber, memberName: 'Juan Dela Cruz', amount: '₱1,250.00', date: '2026-01-20', paymentMethod: 'cash', referenceNumber: 'SV-OCR-1', ...overrides },
    authenticity,
  });

  const forms = await admin.get('/api/ocr/forms');
  assert.deepEqual(forms.data.data.map((form) => form.type), ['Membership Form', 'Loan Form', 'Savings Form', 'Machinery Form', 'Kadiwa Sales Form']);

  // A genuine, complete savings form is verified and posted automatically.
  const posted = await scan(savingsForm());
  assert.equal(posted.captureSource, 'camera');
  assert.equal(posted.verification.status, 'passed', JSON.stringify(posted.verification));
  assert.equal(posted.reviewStatus, 'posted');
  assert.equal(posted.posted.module, 'savings');
  assert.equal(posted.posted.automatically, true);
  assert.equal(posted.extractedData.amount, '1250.00');
  const savings = await admin.get(`/api/members/savings?memberId=${state.memberId}`);
  assert.ok(savings.data.data.some((row) => row.reference === 'SV-OCR-1' && Number(row.amount) === 1250));

  // The same paper form photographed again is not posted twice.
  const twin = await scan(savingsForm());
  assert.equal(twin.verification.status, 'failed');
  assert.equal(twin.posted, null);
  assert.ok(twin.verification.checks.some((check) => check.id === 'duplicate' && check.status === 'fail'));

  // A form the AI judges fake cannot be posted, even by an admin.
  const fake = await scan(savingsForm({ referenceNumber: 'SV-OCR-2' }, { ...genuine, score: 20, verdict: 'fake', issues: ['Amount was overwritten'] }));
  assert.equal(fake.verification.status, 'failed');
  const blocked = await admin.post(`/api/ocr/${fake.id}/post`, { documentType: 'Savings Form', extractedData: fake.extractedData, acknowledgeWarnings: true });
  assert.equal(blocked.status, 422);

  // The name on the form must belong to the member ID on the form.
  const wrongName = await scan(savingsForm({ referenceNumber: 'SV-OCR-3', memberName: 'Pedro Penduko' }));
  assert.ok(wrongName.verification.checks.some((check) => check.id === 'member' && check.status === 'fail'));

  // Warnings (no signature) hold the form for review; the admin confirms and posts it.
  const unsigned = await scan(savingsForm({ referenceNumber: 'SV-OCR-4', amount: '300' }, { ...genuine, signaturePresent: false }));
  assert.equal(unsigned.verification.status, 'warning');
  assert.equal(unsigned.posted, null);
  const needsAck = await admin.post(`/api/ocr/${unsigned.id}/post`, { documentType: 'Savings Form', extractedData: unsigned.extractedData });
  assert.equal(needsAck.status, 422);
  const manual = await admin.post(`/api/ocr/${unsigned.id}/post`, { documentType: 'Savings Form', extractedData: unsigned.extractedData, acknowledgeWarnings: true });
  assert.equal(manual.status, 200, JSON.stringify(manual.data));
  assert.equal(manual.data.data.posted.automatically, false);
  const again = await admin.post(`/api/ocr/${unsigned.id}/post`, { documentType: 'Savings Form', extractedData: unsigned.extractedData, acknowledgeWarnings: true });
  assert.equal(again.status, 409);

  // A Kadiwa sales form whose written total does not add up is rejected.
  const badTotals = await scan({
    documentType: 'Kadiwa Sales Form', confidence: 93, ocrText: 'KADIWA SALES',
    extractedData: { encoderName: 'Maria', saleDate: '2026-01-20', groceriesPrice: '1000', vegetablesPrice: '500', meatPrice: '0', totalExpenses: '100', netSales: '1900' },
    authenticity: { ...genuine, signaturePresent: false },
  }, 'upload');
  assert.ok(badTotals.verification.checks.some((check) => check.id === 'totals' && check.status === 'fail'));

  // A scanned membership form waits for the applicant's valid ID, and for a 2x2 picture when the one on
  // the form cannot be recognized; the system gives the membership number.
  const membership = await scan({
    documentType: 'Membership Form', confidence: 96, ocrText: 'ACIFAC ASSOCIATE MEMBERSHIP FORM',
    extractedData: {
      lastName: 'Magsaysay', firstName: 'Rosa', email: 'rosa.ocr@example.com', phone: '09181234567', dateOfBirth: '03/15/1990', education: 'College',
      address: 'Purok 3', barangay: 'Barahan', municipality: 'Sta. Cruz', province: 'Occidental Mindoro', motherLastName: 'Reyes', motherFirstName: 'Carmen',
      child1Name: 'Ana Magsaysay', child1Age: '7', income1Source: 'Palay farming', income1Amount: '60,000', membershipFeeOrNo: 'OR-501',
      seminarOrNo: 'OR-500', seminarCertifiedBy: 'Lorna Cruz',
    },
    authenticity: { ...genuine, photoRecognized: false },
  });
  assert.equal(membership.requiresIdDocument, true);
  assert.equal(membership.idDocument, null);
  assert.equal(membership.posted, null);
  assert.ok(membership.verification.checks.some((check) => check.id === 'idDocument' && check.status === 'fail'), JSON.stringify(membership.verification));
  assert.ok(membership.verification.checks.some((check) => check.id === 'photo' && check.status === 'fail' && /cannot be recognized/.test(check.message)));
  assert.equal(membership.photoExpected, true);
  assert.equal(membership.photo, null);
  assert.match(membership.verification.target.memberNumber, /^ACIFAC-\d{4}-\d{3}$/);
  const withoutId = await admin.post(`/api/ocr/${membership.id}/post`, { documentType: 'Membership Form', extractedData: membership.extractedData, acknowledgeWarnings: true });
  assert.equal(withoutId.status, 422);

  const submitId = (scanId, source, reading, byte) => {
    stubIdReading = reading;
    const form = new FormData();
    form.append('source', source);
    form.append('idDocument', new Blob([Buffer.concat([PNG, Buffer.from([byte])])], { type: 'image/png' }), `id-${byte}.png`);
    return admin.request('POST', `/api/ocr/${scanId}/id-document`, { form });
  };
  const idCopy = {
    isId: true, idType: 'PhilSys National ID', idNumber: '1234-5678-9012', name: 'ROSA MAGSAYSAY', dateOfBirth: '1990-03-15',
    frontVisible: true, backVisible: true, photocopy: true, physicalCard: false, screen: false, signatureCount: 3, expired: false, issues: [],
  };
  const liveCard = { ...idCopy, photocopy: false, physicalCard: true, signatureCount: 0 };

  // A back-to-back copy needs three specimen signatures. The ID number comes from the ID when the form left it blank.
  const twoSigned = await submitId(membership.id, 'upload', { ...idCopy, signatureCount: 2 }, 1);
  assert.equal(twoSigned.status, 200, JSON.stringify(twoSigned.data));
  assert.equal(twoSigned.data.data.posted, null);
  assert.equal(twoSigned.data.data.idDocument.source, 'upload');
  assert.ok(twoSigned.data.data.verification.checks.some((check) => check.id === 'idDocument' && check.status === 'fail' && /2 specimen signatures/.test(check.message)));
  assert.equal(twoSigned.data.data.extractedData.idNumber, '1234-5678-9012');

  // Someone else's ID is refused, and a live camera capture must be a picture.
  const otherPerson = await submitId(membership.id, 'camera', { ...liveCard, name: 'Pedro Penduko' }, 2);
  assert.equal(otherPerson.data.data.posted, null);
  assert.ok(otherPerson.data.data.verification.checks.some((check) => check.id === 'idMatch' && check.status === 'fail'));
  const pdfForm = new FormData();
  pdfForm.append('source', 'camera');
  pdfForm.append('idDocument', new Blob([Buffer.from('%PDF-1.4 id')], { type: 'application/pdf' }), 'id.pdf');
  assert.equal((await admin.request('POST', `/api/ocr/${membership.id}/id-document`, { form: pdfForm })).status, 400);

  // The applicant's ID card captured with the live camera passes; the form still waits for the 2x2 picture.
  const captured = await submitId(membership.id, 'camera', liveCard, 3);
  assert.equal(captured.status, 200, JSON.stringify(captured.data));
  assert.equal(captured.data.data.posted, null);
  assert.ok(captured.data.data.verification.checks.some((check) => check.id === 'idDocument' && check.status === 'pass'));
  assert.match(captured.data.message, /2x2 picture/);

  const uploadPhoto = (reading, byte) => {
    stubPhotoReading = reading;
    const form = new FormData();
    form.append('photo', new Blob([Buffer.concat([PNG, Buffer.from([byte])])], { type: 'image/png' }), `photo-${byte}.png`);
    return admin.request('POST', `/api/ocr/${membership.id}/photo`, { form });
  };
  // A picture without a clear face is refused; a clear 2x2 picture completes the form, which is then saved automatically.
  const blurred = await uploadPhoto({ portrait: true, faceVisible: false, screen: false, issues: ['blurred'] }, 6);
  assert.equal(blurred.status, 200, JSON.stringify(blurred.data));
  assert.equal(blurred.data.data.posted, null);
  assert.ok(blurred.data.data.verification.checks.some((check) => check.id === 'photo' && check.status === 'fail'));
  const pictured = await uploadPhoto({ portrait: true, faceVisible: true, screen: false, issues: [] }, 7);
  assert.equal(pictured.status, 200, JSON.stringify(pictured.data));
  const saved = pictured.data.data;
  assert.equal(saved.posted?.module, 'members', JSON.stringify(saved.verification));
  assert.equal(saved.posted.recordId, membership.verification.target.memberNumber);
  assert.equal(saved.idDocument.source, 'camera');
  const created = await admin.get(`/api/members?search=${encodeURIComponent('rosa.ocr@example.com')}`);
  const rosa = created.data.data.find((row) => row.member_number === saved.posted.recordId);
  assert.ok(rosa, JSON.stringify(created.data));
  const { data: { data: detail } } = await admin.get(`/api/members/${rosa.id}`);
  assert.equal(detail.id_number, '1234-5678-9012');
  assert.equal(detail.id_type, 'PhilSys National ID');
  assert.equal(detail.education, 'College');
  assert.equal(detail.address, 'Purok 3, Barahan, Sta. Cruz, Occidental Mindoro');
  assert.equal(Number(detail.yearly_income), 60000);
  assert.equal(detail.livelihood, 'Palay farming');
  assert.equal(detail.additional_info.membershipType, 'Associate');
  assert.equal(detail.additional_info.motherMaidenName, 'Carmen Reyes');
  assert.equal(detail.additional_info.orNumber, 'OR-501');
  assert.equal(detail.additional_info.paymentOfMembershipFee, 'Yes');
  assert.equal(detail.additional_info.seminarOrNumber, 'OR-500');
  assert.equal(detail.additional_info.seminarCertifiedBy, 'Lorna Cruz');
  assert.equal(detail.additional_info.preMembershipSeminar, 'Yes');
  assert.deepEqual(detail.additional_info.children, [{ name: 'Ana Magsaysay', age: '7' }]);
  // The submitted ID, not the scanned form, is the member's ID document.
  assert.equal(detail.id_document_name, 'id-3.png');
  const idFile = await admin.request('GET', `/api/members/${rosa.id}/documents/id-document`, { raw: true });
  assert.deepEqual(Buffer.from(await idFile.arrayBuffer()), Buffer.concat([PNG, Buffer.from([3])]));
  const scanId = await admin.request('GET', `/api/ocr/${membership.id}/id-document`, { raw: true });
  assert.equal(scanId.status, 200);
  // The uploaded 2x2 picture is the member's photo.
  const photo = await admin.request('GET', `/api/members/${rosa.id}/documents/photo`, { raw: true });
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.concat([PNG, Buffer.from([7])]));

  // Replacing the member's ID and photo later keeps the scan's copies.
  const replaceForm = new FormData();
  replaceForm.append('idDocument', new Blob([Buffer.concat([PNG, Buffer.from([9])])], { type: 'image/png' }), 'new-id.png');
  replaceForm.append('profilePhoto', new Blob([Buffer.concat([PNG, Buffer.from([10])])], { type: 'image/png' }), 'new-photo.png');
  const replacedDocs = await admin.request('POST', `/api/members/${rosa.id}/documents`, { form: replaceForm });
  assert.equal(replacedDocs.status, 200, JSON.stringify(replacedDocs.data));
  assert.equal((await admin.request('GET', `/api/ocr/${membership.id}/id-document`, { raw: true })).status, 200);
  assert.equal((await admin.request('GET', `/api/ocr/${membership.id}/photo`, { raw: true })).status, 200);

  // Once saved the ID and picture cannot change, and only membership forms take them.
  assert.equal((await submitId(membership.id, 'upload', idCopy, 4)).status, 409);
  assert.equal((await uploadPhoto({ portrait: true, faceVisible: true }, 8)).status, 409);
  assert.equal((await submitId(fake.id, 'upload', idCopy, 5)).status, 400);

  stubAnalysis = DEFAULT_STUB_ANALYSIS;
});

test('ocr: the paper Agri loan form becomes a pending loan application', { skip }, async () => {
  const detail = await admin.get(`/api/members/${state.memberId}`);
  const memberNumber = detail.data.data.member_number;
  const pending = await admin.get('/api/admin/loan-requests?status=pending&limit=100');
  for (const request of pending.data.requests.filter((r) => Number(r.memberDatabaseId) === state.memberId)) {
    await admin.patch(`/api/admin/loan-requests/${request.id}`, { status: 'declined', reason: 'test cleanup' });
  }
  const paperForm = (overrides = {}) => ({
    documentType: 'Loan Form', confidence: 93, ocrText: 'LOAN APPLICATION FORM (AGRI) ACIFAC',
    extractedData: {
      formNo: 'LF-0098', applicationDate: '2026-09-20', memberName: 'Juan Dela Cruz', memberNumber, occupation: 'Farmer', yearsFarming: '15',
      age: '46', civilStatus: 'Married', sex: 'Male', address: 'Purok 1, Amnay', contactNo: '09171234567', email: '',
      farmLocation: 'Sitio Maligaya, Barahan', farmArea: '2', cropsPlanted: 'Palay', cropSeason: 'Wet season 2026', irrigationType: 'Irrigated',
      loanMode: 'Combination',
      fertilizerDescription: 'Urea', fertilizerQuantity: '10', fertilizerUnit: 'bags', fertilizerUnitPrice: '1,500', fertilizerTotal: '15,000',
      seedsDescription: 'Certified seeds', seedsQuantity: '2', seedsUnit: 'bags', seedsUnitPrice: '2500', seedsTotal: '5000',
      grandTotal: '20000', cashAmount: '10,000',
      coMakerName: 'Pedro Cruz', coMakerAddress: 'Purok 2, Amnay', coMakerContact: '09181112222', coMakerRelationship: 'Brother',
      collateralType: 'Harvest', collateralDetails: 'Wet season palay harvest', ...overrides,
    },
    authenticity: { score: 94, verdict: 'genuine', physicalDocument: true, filledIn: true, signaturePresent: true, issues: [] },
  });
  const scan = async (analysis, byte) => {
    stubAnalysis = analysis;
    const form = new FormData();
    form.append('source', 'camera');
    form.append('document', new Blob([Buffer.concat([PNG, Buffer.from([byte])])], { type: 'image/png' }), `loan-${byte}.png`);
    const response = await admin.request('POST', '/api/ocr/analyze', { form });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.data;
  };

  // A complete, genuine loan form waits for the borrower's and the co-maker's IDs.
  const read = await scan(paperForm(), 91);
  assert.equal(read.posted, null);
  assert.deepEqual(read.idRequirements.map((requirement) => requirement.slot), ['holder', 'coMaker']);
  assert.deepEqual(read.idDocuments, { holder: null, coMaker: null });
  for (const id of ['idDocument', 'coMakerId']) assert.ok(read.verification.checks.some((check) => check.id === id && check.status === 'fail'), id);
  assert.ok(read.verification.checks.some((check) => check.id === 'term'));
  assert.ok(!read.verification.checks.some((check) => check.id === 'amounts' && check.status === 'fail'));
  const withoutIds = await admin.post(`/api/ocr/${read.id}/post`, { documentType: 'Loan Form', extractedData: read.extractedData, acknowledgeWarnings: true });
  assert.equal(withoutIds.status, 422);

  const submitId = (path, source, reading, byte) => {
    stubIdReading = reading;
    const form = new FormData();
    form.append('source', source);
    form.append('idDocument', new Blob([Buffer.concat([PNG, Buffer.from([byte])])], { type: 'image/png' }), `loan-id-${byte}.png`);
    return admin.request('POST', `/api/ocr/${read.id}/${path}`, { form });
  };
  const signedCopy = {
    isId: true, idType: 'PhilSys National ID', idNumber: '1111-2222-3333', name: 'JUAN DELA CRUZ', dateOfBirth: '1980-05-20', address: 'Purok 1, Amnay, Sta. Cruz, Occidental Mindoro',
    frontVisible: true, backVisible: true, photocopy: true, physicalCard: false, screen: false, signatureCount: 3, expired: false, issues: [],
  };
  const coMakerCopy = { ...signedCopy, idType: 'Driver\'s License', idNumber: 'D01-23-456789', name: 'PEDRO CRUZ', dateOfBirth: '1984-02-11', address: 'Purok 2, Amnay, Sta. Cruz' };

  // The borrower's own ID cannot be the co-maker's ID.
  const borrowersAsCoMaker = await submitId('co-maker-id', 'upload', signedCopy, 101);
  assert.equal(borrowersAsCoMaker.status, 200, JSON.stringify(borrowersAsCoMaker.data));
  assert.equal(borrowersAsCoMaker.data.data.idDocuments.coMaker.source, 'upload');
  assert.ok(borrowersAsCoMaker.data.data.verification.checks.some((check) => check.id === 'coMakerMatch' && check.status === 'fail' && /borrower's name/.test(check.message)));

  // Without 3 specimen signatures the borrower's ID is refused, even taken with the camera.
  const twoSigned = await submitId('id-document', 'camera', { ...signedCopy, signatureCount: 2, photocopy: false, physicalCard: true }, 102);
  assert.equal(twoSigned.status, 200, JSON.stringify(twoSigned.data));
  assert.ok(twoSigned.data.data.verification.checks.some((check) => check.id === 'idDocument' && check.status === 'fail' && /2 specimen signatures/.test(check.message)));
  // Someone else's ID is not the borrower's.
  const stranger = await submitId('id-document', 'upload', { ...signedCopy, name: 'MARIA SANTOS', dateOfBirth: '1990-01-01' }, 103);
  const strangerMatch = stranger.data.data.verification.checks.find((check) => check.id === 'idMatch');
  assert.equal(strangerMatch.status, 'fail');
  assert.match(strangerMatch.message, /not the borrower on the form/);

  // The borrower's signed copy taken with the camera: name, birthday on record, age and address agree.
  const borrower = await submitId('id-document', 'camera', signedCopy, 104);
  assert.equal(borrower.data.data.posted, null);
  assert.equal(borrower.data.data.idDocuments.holder.source, 'camera');
  assert.equal(borrower.data.data.idDocuments.holder.reading.address, signedCopy.address);
  const borrowerChecks = Object.fromEntries(borrower.data.data.verification.checks.map((check) => [check.id, check]));
  assert.equal(borrowerChecks.idDocument.status, 'pass', JSON.stringify(borrowerChecks.idDocument));
  assert.equal(borrowerChecks.idMatch.status, 'pass', JSON.stringify(borrowerChecks.idMatch));
  assert.match(borrowerChecks.idMatch.message, /birthday and address match/);
  assert.equal(borrowerChecks.coMakerMatch.status, 'fail', 'the co-maker ID on file is still the borrower\'s');

  // A loan form takes no 2x2 picture.
  const photoForm = new FormData();
  photoForm.append('photo', new Blob([Buffer.concat([PNG, Buffer.from([105])])], { type: 'image/png' }), 'photo.png');
  assert.equal((await admin.request('POST', `/api/ocr/${read.id}/photo`, { form: photoForm })).status, 400);

  // The co-maker's own ID completes the form, which is then saved automatically.
  const completed = await submitId('co-maker-id', 'upload', coMakerCopy, 106);
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  const posted = completed.data.data;
  assert.equal(posted.posted?.module, 'loans', JSON.stringify(posted.verification));
  assert.ok(posted.verification.checks.some((check) => check.id === 'coMakerMatch' && check.status === 'pass'));
  assert.equal((await admin.request('GET', `/api/ocr/${read.id}/co-maker-id`, { raw: true })).status, 200);
  assert.equal((await admin.request('GET', `/api/ocr/${read.id}/id-document`, { raw: true })).status, 200);
  assert.equal((await submitId('co-maker-id', 'upload', coMakerCopy, 107)).status, 409);
  const requests = await admin.get('/api/admin/loan-requests?status=pending&limit=100');
  const request = requests.data.requests.find((r) => String(r.id) === posted.posted.recordId);
  assert.equal(Number(request.amount), 30000, 'cash 10,000 + in-kind 20,000');
  assert.equal(request.loanMode, 'combination');
  assert.equal(request.irrigationType, 'irrigated');
  assert.equal(request.collateralType, 'Harvest');
  assert.equal(request.inKindItems.length, 2);
  assert.equal(request.coMakerName, 'Pedro Cruz');
  assert.equal(request.idDocuments.borrower.scanId, read.id);
  assert.equal(request.idDocuments.coMaker.reading.name, 'PEDRO CRUZ');
  assert.equal((await admin.request('GET', `/api/admin/loan-requests/${request.id}/id-documents/coMaker`, { raw: true })).status, 200);

  const wrongTotals = await scan(paperForm({ formNo: 'LF-0099', fertilizerTotal: '14,000', grandTotal: '19000' }), 92);
  assert.equal(wrongTotals.posted, null);
  assert.ok(wrongTotals.verification.checks.some((check) => check.id === 'amounts' && check.status === 'fail'));

  // The borrower cannot be their own co-maker, and only a loan form takes a co-maker's ID.
  const selfCoMaker = await scan(paperForm({ formNo: 'LF-0100', coMakerName: 'Juan Dela Cruz' }), 93);
  assert.ok(selfCoMaker.verification.checks.some((check) => check.id === 'coMaker' && check.status === 'fail'));
  stubAnalysis = DEFAULT_STUB_ANALYSIS;
  const receipt = await scan({ ...DEFAULT_STUB_ANALYSIS }, 94);
  const receiptId = new FormData();
  receiptId.append('idDocument', new Blob([Buffer.concat([PNG, Buffer.from([108])])], { type: 'image/png' }), 'id.png');
  assert.equal((await admin.request('POST', `/api/ocr/${receipt.id}/co-maker-id`, { form: receiptId })).status, 400);
});

test('ocr: retired or busy Gemini models fall back, and failed readings can be retried', { skip }, async () => {
  const scanFile = (bytes, name) => { const form = new FormData(); form.append('document', new Blob([Buffer.concat([PNG, Buffer.from(bytes)])], { type: 'image/png' }), name); return form; };

  // A retired model (404) and a busy one (503) are skipped for the next model.
  Object.assign(process.env, { GEMINI_API_KEY: 'test-gemini', GEMINI_MODEL: 'gemini-2.5-flash', GEMINI_API_BASE: `http://127.0.0.1:${stubServer.address().port}/gemini` });
  try {
    const viaFallback = await admin.request('POST', '/api/ocr/analyze', { form: scanFile([201], 'fallback.png') });
    assert.equal(viaFallback.status, 201, JSON.stringify(viaFallback.data));
    assert.equal(viaFallback.data.data.processingStatus, 'completed');
    assert.deepEqual(geminiCalls, ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest']);
  } finally {
    Object.assign(process.env, { GEMINI_API_KEY: '', GEMINI_MODEL: '', GEMINI_API_BASE: '' });
  }

  // When the AI is down the scan is kept, and Retry reads the stored file again.
  stubMode = 'fail';
  const failed = await admin.request('POST', '/api/ocr/analyze', { form: scanFile([202], 'busy.png') });
  assert.equal(failed.data.data.processingStatus, 'failed');
  assert.match(failed.data.data.processingError, /busy/i);
  const stillDown = await admin.post(`/api/ocr/${failed.data.data.id}/retry`);
  assert.equal(stillDown.status, 503);
  stubMode = 'ok';
  const retried = await admin.post(`/api/ocr/${failed.data.data.id}/retry`);
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(retried.data.data.processingStatus, 'completed');
  assert.equal(retried.data.data.documentType, 'Payment Receipt');
  const again = await admin.post(`/api/ocr/${failed.data.data.id}/retry`);
  assert.equal(again.status, 409);
});

test('member emails: savings, share capital, loan application, scanned forms, opt-out', { skip }, async () => {
  const address = (await pool.query(
    `SELECT COALESCE(NULLIF(u.email, ''), m.email) AS email FROM members m LEFT JOIN users u ON u.member_id = m.id WHERE m.id = $1`, [state.memberId]
  )).rows[0].email;
  const mailsFor = (pattern) => sentEmails.filter((mail) => mail.to === address && pattern.test(mail.subject));
  // Emails go out after the response; wait briefly for them.
  const waitForMail = async (pattern, count) => {
    for (let i = 0; i < 60 && mailsFor(pattern).length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    return mailsFor(pattern);
  };

  const savingsBefore = mailsFor(/savings deposit recorded/i).length;
  const saved = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '123.45', date: '2026-09-01', paymentMethod: 'Cash', reference: 'EMAIL-1' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const savingsMail = await waitForMail(/savings deposit recorded/i, savingsBefore + 1);
  assert.equal(savingsMail.length, savingsBefore + 1);
  assert.match(savingsMail.at(-1).text, /PHP 123\.45/);
  assert.match(savingsMail.at(-1).text, /Juan/);

  const share = await admin.post(`/api/members/${state.memberId}/share-contributions`, { amount: '100', contributionDate: '2026-09-01' });
  assert.equal(share.status, 201, JSON.stringify(share.data));
  assert.equal((await waitForMail(/share capital contribution recorded/i, 1)).length >= 1, true);

  const applicationsBefore = mailsFor(/received your loan application/i).length;
  const applied = await applyWithIds(member, '/api/members/me/loan-requests', { loanType: 'personal', loanMode: 'cash', purpose: 'Seeds', amount: '5000', term: '6', farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay' });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const applicationMail = await waitForMail(/received your loan application/i, applicationsBefore + 1);
  assert.ok(applicationMail.some((mail) => mail.text.includes(`#${applied.data.request.id}`)));

  // Records the OCR scanner saved earlier told the member they came from a paper form.
  assert.ok(sentEmails.some((mail) => mail.to === address && /paper form/.test(mail.text)));

  // Turning off Email notifications stops activity emails.
  await member.patch('/api/auth/notification-preferences', { emailNotifications: false, loanReminders: true });
  const quietBefore = mailsFor(/savings deposit recorded/i).length;
  await admin.post('/api/members/savings', { memberId: state.memberId, amount: '10', date: '2026-09-01', paymentMethod: 'Cash', reference: 'EMAIL-2' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(mailsFor(/savings deposit recorded/i).length, quietBefore, 'no email after opting out');
  await member.patch('/api/auth/notification-preferences', { emailNotifications: true, loanReminders: true });
});

test('notifications, announcements and live updates', { skip }, async () => {
  const events = [];
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/events`, { headers: { Cookie: member.cookie }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const match of decoder.decode(value).matchAll(/event: change\ndata: (.*)\n/g)) events.push(JSON.parse(match[1]));
      }
    } catch { /* aborted */ }
  })();
  await new Promise((resolve) => setTimeout(resolve, 200));

  const announcement = await admin.post('/api/announcements', { title: 'General Assembly', message: 'Meeting on Saturday', audience: 'All Members' });
  assert.equal(announcement.status, 201);
  await admin.post('/api/members/savings', { memberId: state.memberId, amount: '100', date: '2026-02-03' });
  await admin.post(`/api/members/${state.memberId}/share-contributions`, { amount: '100', contributionDate: '2026-02-03' });
  await admin.post('/api/kadiwa/sales', { encoderName: 'Tester', groceriesPrice: '50' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  controller.abort();
  await pump;

  const tables = new Set(events.map((event) => event.table));
  assert.ok(tables.has('announcements'), 'announcement event delivered');
  assert.ok(tables.has('savings_transactions'), 'own savings event delivered');
  assert.ok(tables.has('share_contributions'), 'own share contribution event delivered');
  assert.ok(tables.has('notifications'), 'own notification event delivered');
  assert.ok(!tables.has('kadiwa_sales'), 'admin-only table not delivered to members');
  assert.ok(events.every((event) => Object.keys(event).sort().join() === 'op,table'), 'no record data in events');

  const list = await member.get('/api/announcements');
  assert.equal(list.data.data[0].title, 'General Assembly');
  assert.equal((await member.post('/api/announcements', { title: 'x', message: 'y' })).status, 403);

  const notes = await member.get('/api/notifications');
  assert.ok(notes.data.unreadCount > 0);
  const first = notes.data.data[0];
  assert.equal((await member.patch(`/api/notifications/${first.id}/read`)).status, 200);
  const adminNote = (await admin.get('/api/notifications')).data.data[0];
  assert.equal((await member.patch(`/api/notifications/${adminNote.id}/read`)).status, 404, 'cannot touch another user\'s notification');
  await member.patch('/api/notifications/read-all');
  assert.equal((await member.get('/api/notifications')).data.unreadCount, 0);
});

test('dashboard and analytics use real data', { skip }, async () => {
  const dashboard = await admin.get('/api/admin/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.stats.totalMembers, 3); // two registered directly, one from a scanned membership form
  assert.ok(dashboard.data.recentActivities.length > 0);
  const analytics = await admin.get('/api/admin/analytics?from=2000-01-01&to=2999-12-31');
  assert.equal(analytics.status, 200, JSON.stringify(analytics.data));
  assert.equal(analytics.data.summary.completedLoans, 1);
  assert.equal(analytics.data.summary.totalLoanPayments, 51250);
  const juan = analytics.data.memberAnalytics.find((row) => row.databaseId === state.memberId);
  assert.equal(juan.totalPaid, 51250);
  assert.ok(analytics.data.methodology.onTimePaymentRate);
});

test('settings: profile, preferences, legal documents', { skip }, async () => {
  const profile = await admin.patch('/api/auth/profile', { name: 'Coop Admin', phone: '09170000000', position: 'Manager' });
  assert.equal(profile.status, 200);
  assert.equal((await admin.get('/api/auth/me')).data.user.display_name, 'Coop Admin');
  const prefs = await member.patch('/api/auth/notification-preferences', { emailNotifications: false, loanReminders: true });
  assert.equal(prefs.data.preferences.emailNotifications, false);

  const form = new FormData();
  form.append('document', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'bylaws.pdf');
  form.append('category', 'Governance');
  const uploaded = await admin.request('POST', '/api/legal-documents', { form });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.equal((await admin.request('GET', `/api/legal-documents/${uploaded.data.data.id}/file`, { raw: true })).status, 200);
  assert.equal((await admin.request('DELETE', `/api/legal-documents/${uploaded.data.data.id}`)).status, 200);
  assert.equal((await admin.get('/api/legal-documents')).data.data.length, 0);
});

test('member activity log: own actions, office actions, filters, privacy', { skip }, async () => {
  const before = await member.get('/api/auth/me');
  assert.equal((await member.request('PATCH', '/api/auth/profile', { body: { phone: '09175550000' } })).status, 200);
  assert.equal((await member.patch('/api/auth/notification-preferences', { emailNotifications: true, loanReminders: false })).status, 200);
  await member.patch('/api/auth/notification-preferences', { emailNotifications: true, loanReminders: true });
  assert.equal((await new Client().post('/api/auth/login', { usernameOrEmail: 'juan', password: 'Wrong-password-1' })).status, 401);
  // Another member's savings must never show up in Juan's log.
  const second = await admin.get(`/api/members/${state.secondMemberId}`);
  assert.equal((await admin.post('/api/members/savings', { memberId: state.secondMemberId, amount: '77', date: '2026-09-01', paymentMethod: 'Cash', reference: 'OTHER-1' })).status, 201);

  const all = await member.get('/api/members/me/activity?limit=50');
  assert.equal(all.status, 200, JSON.stringify(all.data));
  const actions = all.data.data.map((entry) => entry.action);
  for (const action of ['LOGIN', 'PROFILE_UPDATED', 'NOTIFICATION_PREFERENCES_UPDATED', 'LOGIN_FAILURE', 'SAVINGS_DEPOSIT_CREATED', 'LOAN_APPLICATION_SUBMITTED']) assert.ok(actions.includes(action), action);
  const profile = all.data.data.find((entry) => entry.action === 'PROFILE_UPDATED');
  assert.equal(profile.actor, 'you');
  assert.ok(profile.changes.includes('phone number'));
  assert.equal(all.data.data.find((entry) => entry.action === 'LOGIN_FAILURE').status, 'failed');
  const office = all.data.data.find((entry) => entry.action === 'SAVINGS_DEPOSIT_CREATED');
  assert.equal(office.actor, 'office');
  assert.equal(office.device, null);
  assert.equal(office.ipAddress, null);
  assert.ok(!JSON.stringify(all.data).includes('testadmin'), 'administrator names are never shown');
  assert.ok(!JSON.stringify(all.data).includes(second.data.data.member_number), 'no entries about other members');
  assert.ok(all.data.summary.lastSignIn);
  assert.ok(all.data.summary.failedSignIns30Days >= 1);

  const onlySavings = await member.get('/api/members/me/activity?category=savings&limit=50');
  assert.ok(onlySavings.data.data.length > 0 && onlySavings.data.data.every((entry) => entry.category === 'savings'));
  const onlyOffice = await member.get('/api/members/me/activity?actor=office&limit=50');
  assert.ok(onlyOffice.data.data.every((entry) => entry.actor === 'office'));
  const onlyMine = await member.get('/api/members/me/activity?actor=me&limit=50');
  assert.ok(onlyMine.data.data.length > 0 && onlyMine.data.data.every((entry) => entry.actor === 'you'));
  const failed = await member.get('/api/members/me/activity?status=FAILED');
  assert.ok(failed.data.data.length > 0 && failed.data.data.every((entry) => entry.status === 'failed'));
  const future = await member.get('/api/members/me/activity?fromDate=2999-01-01');
  assert.equal(future.data.pagination.total, 0);
  const searched = await member.get('/api/members/me/activity?search=signed%20in');
  assert.ok(searched.data.data.length > 0 && searched.data.data.every((entry) => entry.action === 'LOGIN'));
  const paged = await member.get('/api/members/me/activity?limit=2&page=2');
  assert.equal(paged.data.data.length, 2);
  assert.equal((await member.get('/api/members/me/activity?category=nope')).status, 400);
  assert.equal((await admin.get('/api/members/me/activity')).status, 403, 'members only');

  await member.request('PATCH', '/api/auth/profile', { body: { phone: before.data.user.phone } });
});

test('profile pictures: own only, admins see members, members never see admins', { skip }, async () => {
  const photoForm = (bytes) => { const form = new FormData(); form.append('photo', new Blob([bytes], { type: 'image/png' }), 'me.png'); return form; };
  const adminPicture = Buffer.concat([PNG, Buffer.from('admin')]);
  const memberPicture = Buffer.concat([PNG, Buffer.from('member')]);

  assert.equal((await admin.request('GET', '/api/auth/profile-photo', { raw: true })).status, 404);
  const notImage = await admin.request('POST', '/api/auth/profile-photo', { form: (() => { const f = new FormData(); f.append('photo', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'x.png'); return f; })() });
  assert.equal(notImage.status, 400);
  assert.equal((await admin.request('POST', '/api/auth/profile-photo', { form: photoForm(adminPicture) })).status, 200);
  const adminOwn = await admin.request('GET', '/api/auth/profile-photo', { raw: true });
  assert.equal(adminOwn.status, 200);
  assert.equal(adminOwn.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await adminOwn.arrayBuffer()), adminPicture);

  // The member only ever receives their own picture, never the admin's.
  assert.equal((await member.request('POST', '/api/auth/profile-photo', { form: photoForm(memberPicture) })).status, 200);
  const memberOwn = await member.request('GET', '/api/auth/profile-photo', { raw: true });
  assert.deepEqual(Buffer.from(await memberOwn.arrayBuffer()), memberPicture);
  assert.equal((await member.request('GET', `/api/members/${state.secondMemberId}/documents/avatar`, { raw: true })).status, 403, 'members cannot reach other members pictures');

  // Admins see a member's picture in Associates.
  const seenByAdmin = await admin.request('GET', `/api/members/${state.memberId}/documents/avatar`, { raw: true });
  assert.equal(seenByAdmin.status, 200);
  assert.deepEqual(Buffer.from(await seenByAdmin.arrayBuffer()), memberPicture);

  assert.equal((await member.request('DELETE', '/api/auth/profile-photo')).status, 200);
  // A 2x2 registration photo on the member record is not used as the member's picture.
  await pool.query(`UPDATE members SET profile_photo = 'local://member-photos/test/registration.png' WHERE id = $1`, [state.memberId]);
  assert.equal((await member.request('GET', '/api/auth/profile-photo', { raw: true })).status, 404);
  await pool.query('UPDATE members SET profile_photo = NULL WHERE id = $1', [state.memberId]);
  assert.equal((await admin.request('DELETE', '/api/auth/profile-photo')).status, 200);
});

test('sessions: forgot password, change password, deactivation, logout', { skip }, async () => {
  // Members reset with the email on their account, like administrators.
  const resetter = new Client('10.0.1.1');
  const forgot = await resetter.post('/api/auth/forgot-password', { email: 'JUAN@example.com' });
  assert.equal(forgot.status, 200);
  const unknown = await new Client('10.0.1.2').post('/api/auth/forgot-password', { email: 'nobody@example.com' });
  assert.equal(unknown.data.message, forgot.data.message, 'no account enumeration');
  const { code } = await nextResetCode('juan@example.com');
  assert.equal((await resetter.post('/api/auth/verify-reset-code', { email: 'juan@example.com', code })).status, 200);
  assert.equal((await resetter.post('/api/auth/reset-password', { newPassword: 'weak', confirmPassword: 'weak' })).status, 400);
  assert.equal((await resetter.post('/api/auth/reset-password', { newPassword: 'ResetPass1!', confirmPassword: 'ResetPass1!' })).status, 200);
  assert.equal((await member.post('/api/auth/login', { usernameOrEmail: 'juan', password: 'ResetPass1!' })).status, 200);

  const change = await member.post('/api/auth/change-password', { currentPassword: 'ResetPass1!', newPassword: 'ChangedPass1!', confirmPassword: 'ChangedPass1!' });
  assert.equal(change.status, 200);
  assert.equal((await member.get('/api/auth/me')).status, 401, 'change password ends the session');
  await member.post('/api/auth/login', { usernameOrEmail: 'juan', password: 'ChangedPass1!' });
  assert.equal((await member.get('/api/members/me')).status, 200);

  assert.equal((await admin.patch(`/api/admin/accounts/${state.memberUserId}/status`, { status: 'LOCKED' })).status, 200);
  const afterLock = await member.get('/api/members/me');
  assert.equal(afterLock.status, 401);
  assert.equal((await member.post('/api/auth/login', { usernameOrEmail: 'juan', password: 'ChangedPass1!' })).status, 403);
  await admin.patch(`/api/admin/accounts/${state.memberUserId}/status`, { status: 'ACTIVE' });
  assert.equal((await member.post('/api/auth/login', { usernameOrEmail: 'juan', password: 'ChangedPass1!' })).status, 200);
  const statusAudit = await admin.get('/api/admin/audit-logs?action=ACCOUNT_STATUS_UPDATED');
  assert.equal(statusAudit.data.data.at(-1).old_values.account_status, 'ACTIVE');
  assert.equal(statusAudit.data.data.at(-1).new_values.account_status, 'LOCKED');

  assert.equal((await member.post('/api/auth/logout')).status, 200);
  assert.equal((await member.get('/api/auth/me')).status, 401);
  const leaked = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE details::text ILIKE '%password_hash%' OR old_values::text ILIKE '%password_hash%' OR new_values::text ILIKE '%$2b$%'`);
  assert.equal(leaked.rows[0].n, 0, 'no password hashes in audit logs');
});

// ----- Login security ------------------------------------------------------------

test('login lockout: third wrong password locks the account for 20 minutes everywhere', { skip }, async () => {
  const userId = await createLoginUser('lockme', 'lockme@acifac.local', 'LockPass1!');
  const accountKey = `user:${userId}`;
  const browser = new Client('10.0.2.1');

  // Attempts 1 and 2: the usual error, counted on the account.
  const first = await browser.post('/api/auth/login', { usernameOrEmail: 'lockme', password: 'Wrong-pass-1' });
  assert.equal(first.status, 401);
  assert.equal(first.data.code, 'INVALID_CREDENTIALS');
  assert.equal(first.data.message, 'Invalid username or password.');
  assert.equal(first.data.attemptsRemaining, 2);
  // The same account under another sign-in name shares the count.
  const second = await new Client('10.0.2.2').post('/api/auth/login', { usernameOrEmail: 'LOCKME@acifac.local', password: 'Wrong-pass-2' });
  assert.equal(second.status, 401);
  assert.equal(second.data.attemptsRemaining, 1);
  assert.equal((await pool.query('SELECT failed_attempts FROM login_throttles WHERE throttle_key = $1', [accountKey])).rows[0].failed_attempts, 2);

  // Attempt 3: locked for 20 minutes.
  const third = await browser.post('/api/auth/login', { usernameOrEmail: 'lockme', password: 'Wrong-pass-3' });
  assert.equal(third.status, 429);
  assert.equal(third.data.code, 'LOGIN_LOCKED');
  assert.equal(third.data.message, 'Too many failed login attempts. Please try again in 20 minutes.');
  assert.ok(third.data.retryAfterSeconds > 1190 && third.data.retryAfterSeconds <= 1200, String(third.data.retryAfterSeconds));
  assert.equal(third.headers.get('retry-after'), String(third.data.retryAfterSeconds));
  const stored = await pool.query(`SELECT locked_until > NOW() + INTERVAL '19 minutes' AS locked FROM login_throttles WHERE throttle_key = $1`, [accountKey]);
  assert.equal(stored.rows[0].locked, true);

  // During the lock the correct password is refused: same browser, a fresh
  // browser (refresh / other tab / other browser) and a bare API call alike.
  for (const client of [browser, new Client('10.0.2.3'), new Client('10.0.2.4')]) {
    const blocked = await client.post('/api/auth/login', { usernameOrEmail: 'lockme', password: 'LockPass1!' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'LOGIN_LOCKED');
    assert.ok(blocked.data.retryAfterSeconds <= third.data.retryAfterSeconds);
    assert.equal(client.cookies.has('session_token'), false, 'no session while locked');
  }
  const bare = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-Forwarded-For': '10.0.2.5' }, body: JSON.stringify({ usernameOrEmail: 'lockme', password: 'LockPass1!' }) });
  assert.equal(bare.status, 429);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1', [userId])).rows[0].n, 0);

  // The lock ends after 20 minutes (simulated): sign-in works and the count resets.
  await pool.query(`UPDATE login_throttles SET locked_until = NOW() - INTERVAL '1 second' WHERE throttle_key = $1`, [accountKey]);
  const after = await browser.post('/api/auth/login', { usernameOrEmail: 'lockme', password: 'LockPass1!' });
  assert.equal(after.status, 200, JSON.stringify(after.data));
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM login_throttles WHERE throttle_key = $1', [accountKey])).rows[0].n, 0, 'success clears the count');
  const fresh = await new Client('10.0.2.6').post('/api/auth/login', { usernameOrEmail: 'lockme', password: 'Wrong-pass-4' });
  assert.equal(fresh.data.attemptsRemaining, 2, 'full allowance after a successful sign-in');

  const audit = await pool.query(`SELECT action FROM audit_logs WHERE user_id = $1 OR entity_id = $2`, [userId, String(userId)]);
  const actions = audit.rows.map((row) => row.action);
  for (const action of ['LOGIN_FAILURE', 'LOGIN_LOCKED', 'LOGIN_BLOCKED', 'LOGIN']) assert.ok(actions.includes(action), action);
  const leaked = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE details::text LIKE '%LockPass1!%' OR details::text LIKE '%Wrong-pass%'`);
  assert.equal(leaked.rows[0].n, 0, 'passwords are never logged');
});

test('login lockout: unknown names lock the same way, and each address has a limit', { skip }, async () => {
  const guesser = new Client('10.0.3.1');
  const replies = [];
  for (let attempt = 0; attempt < 3; attempt += 1) replies.push(await guesser.post('/api/auth/login', { usernameOrEmail: 'no-such-user', password: 'Wrong-pass-1' }));
  assert.deepEqual(replies.map((reply) => reply.status), [401, 401, 429], 'identical to a real account');
  assert.deepEqual(replies.slice(0, 2).map((reply) => reply.data.attemptsRemaining), [2, 1]);
  assert.equal(replies[2].data.code, 'LOGIN_LOCKED');

  // Password spraying: many names from one address (LOGIN_IP_MAX_FAILURES=6 here).
  const sprayer = new Client('10.0.3.2');
  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await sprayer.post('/api/auth/login', { usernameOrEmail: `spray-${attempt}`, password: 'Wrong-pass-1' })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  const lockedAddress = await sprayer.post('/api/auth/login', { usernameOrEmail: 'testadmin', password: 'AdminPass1!' });
  assert.equal(lockedAddress.status, 429, 'even a correct password from the locked address');
  assert.equal((await new Client('10.0.3.3').post('/api/auth/login', { usernameOrEmail: 'testadmin', password: 'AdminPass1!' })).status, 200, 'other addresses are unaffected');
});

test('password reset: emailed 6-digit code, limits, single use, sessions ended', { skip }, async () => {
  const userId = await createLoginUser('resetme', 'resetme@acifac.local', 'OldPass1!');
  const email = 'resetme@acifac.local';
  const seen = new Set();
  const browser = new Client('10.0.4.1');
  const signedIn = new Client('10.0.4.9');
  assert.equal((await signedIn.post('/api/auth/login', { usernameOrEmail: 'resetme', password: 'OldPass1!' })).status, 200);
  const allowRequest = () => pool.query(`UPDATE password_reset_codes SET created_at = created_at - INTERVAL '61 seconds'`);

  assert.equal((await browser.post('/api/auth/forgot-password', { email: 'not-an-email' })).status, 400);

  // Registered and unknown addresses get exactly the same reply.
  const known = await browser.post('/api/auth/forgot-password', { email: 'ResetMe@acifac.local' });
  const unknown = await new Client('10.0.4.2').post('/api/auth/forgot-password', { email: 'ghost@acifac.local' });
  assert.equal(known.status, 200);
  assert.deepEqual(unknown.data, known.data);
  assert.equal(known.data.message, 'If an account with that email exists, a verification code has been sent.');
  assert.equal(known.data.resendAvailableInSeconds, 60);
  const { code: firstCode, mail } = await nextResetCode(email, seen);
  assert.match(firstCode, /^\d{6}$/);
  assert.match(mail.text, /Your verification code is:/);
  assert.match(mail.text, /This code expires in 10 minutes\./);
  assert.ok(!/https?:\/\//.test(mail.text) && !mail.html.includes('href'), 'no link, code only');
  assert.ok(!sentEmails.some((entry) => entry.to === 'ghost@acifac.local'), 'nothing is sent to unknown addresses');
  const rows = await pool.query('SELECT code_hash FROM password_reset_codes WHERE user_id = $1', [userId]);
  assert.ok(rows.rows[0].code_hash.startsWith('$2') && !rows.rows[0].code_hash.includes(firstCode), 'only a bcrypt hash is stored');

  // Resend cooldown, the same for unknown addresses.
  const tooSoon = await browser.post('/api/auth/forgot-password', { email });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.data.code, 'RESET_CODE_COOLDOWN');
  assert.ok(tooSoon.data.retryAfterSeconds > 0 && tooSoon.data.retryAfterSeconds <= 60);
  assert.equal((await new Client('10.0.4.2').post('/api/auth/forgot-password', { email: 'ghost@acifac.local' })).data.code, 'RESET_CODE_COOLDOWN');

  // Wrong, malformed and unknown-address codes.
  const wrongCode = firstCode === '000000' ? '000001' : '000000';
  const wrong = await browser.post('/api/auth/verify-reset-code', { email, code: wrongCode });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.message, 'Invalid verification code.');
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email, code: '12ab56' })).data.code, 'RESET_CODE_INVALID');
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email: 'ghost@acifac.local', code: firstCode })).data.code, 'RESET_CODE_INVALID');

  // Expired code.
  await pool.query(`UPDATE password_reset_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1`, [userId]);
  const expired = await browser.post('/api/auth/verify-reset-code', { email, code: firstCode });
  assert.equal(expired.status, 400);
  assert.equal(expired.data.code, 'RESET_CODE_EXPIRED');
  assert.equal(expired.data.message, 'This verification code has expired. Please request a new code.');

  // A new code replaces the old one; five wrong guesses cancel it.
  await allowRequest();
  assert.equal((await browser.post('/api/auth/forgot-password', { email })).status, 200);
  const { code: secondCode } = await nextResetCode(email, seen);
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email, code: firstCode === secondCode ? wrongCode : firstCode })).data.code, 'RESET_CODE_INVALID', 'old code no longer works');
  const guesses = [];
  const badGuess = secondCode === '999999' ? '999998' : '999999';
  for (let attempt = 0; attempt < 4; attempt += 1) guesses.push(await browser.post('/api/auth/verify-reset-code', { email, code: badGuess }));
  assert.deepEqual(guesses.map((guess) => guess.status), [400, 400, 400, 429]);
  assert.equal(guesses.at(-1).data.code, 'RESET_CODE_LOCKED');
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email, code: secondCode })).data.code, 'RESET_CODE_LOCKED', 'the right code is refused after too many attempts');

  // Correct code: an httpOnly grant cookie for the auth routes, nothing in the body.
  await allowRequest();
  assert.equal((await browser.post('/api/auth/forgot-password', { email })).status, 200);
  const { code } = await nextResetCode(email, seen);
  const verified = await browser.post('/api/auth/verify-reset-code', { email, code });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  const grantCookie = verified.headers.getSetCookie().find((header) => header.startsWith('password_reset_grant='));
  assert.match(grantCookie, /HttpOnly/i);
  assert.match(grantCookie, /Path=\/api\/auth/);
  const grant = browser.cookies.get('password_reset_grant');
  assert.ok(grant && !JSON.stringify(verified.data).includes(grant));
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email, code })).data.code, 'RESET_CODE_USED');

  // New password rules.
  const mismatch = await browser.post('/api/auth/reset-password', { newPassword: 'NewPass1!', confirmPassword: 'NewPass2!' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.message, 'Passwords do not match.');
  assert.match((await browser.post('/api/auth/reset-password', { newPassword: 'short', confirmPassword: 'short' })).data.message, /at least 8 characters/);
  assert.match((await browser.post('/api/auth/reset-password', { newPassword: 'OldPass1!', confirmPassword: 'OldPass1!' })).data.message, /different from your current password/);
  const noGrant = await new Client('10.0.4.3').post('/api/auth/reset-password', { newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' });
  assert.equal(noGrant.data.code, 'RESET_SESSION_EXPIRED');

  // Lock the account first: a completed reset also lifts the lockout.
  for (let attempt = 0; attempt < 3; attempt += 1) await new Client('10.0.4.4').post('/api/auth/login', { usernameOrEmail: 'resetme', password: 'Wrong-pass-1' });
  const reset = await browser.post('/api/auth/reset-password', { newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.message, 'Password reset successful.');
  assert.equal(browser.cookies.has('password_reset_grant'), false, 'grant cookie cleared');

  // Single use: neither the code nor the grant works again.
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email, code })).data.code, 'RESET_CODE_USED');
  const replay = await fetch(`${baseUrl}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: `password_reset_grant=${grant}` }, body: JSON.stringify({ newPassword: 'Other1pass!', confirmPassword: 'Other1pass!' }) });
  assert.equal((await replay.json()).code, 'RESET_SESSION_EXPIRED');

  // Old sessions are ended; the new password works, the old one does not.
  assert.equal((await signedIn.get('/api/auth/me')).status, 401);
  assert.equal((await new Client('10.0.4.5').post('/api/auth/login', { usernameOrEmail: 'resetme', password: 'OldPass1!' })).status, 401);
  assert.equal((await new Client('10.0.4.6').post('/api/auth/login', { usernameOrEmail: 'resetme', password: 'NewPass1!' })).status, 200);

  const audit = await pool.query('SELECT action, description, details, old_values, new_values FROM audit_logs WHERE user_id = $1 ORDER BY id', [userId]);
  const actions = audit.rows.map((row) => row.action);
  for (const action of ['PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_CODE_SENT', 'PASSWORD_RESET_CODE_FAILED', 'PASSWORD_RESET_CODE_VERIFIED', 'PASSWORD_RESET_COMPLETED']) assert.ok(actions.includes(action), action);
  const logged = JSON.stringify(audit.rows);
  for (const secret of [...seen, grant, 'NewPass1!']) assert.ok(!logged.includes(secret), 'codes, grants and passwords are never logged');
});

test('password reset: hourly limit per address', { skip }, async () => {
  const client = new Client('10.0.5.1');
  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await pool.query(`UPDATE password_reset_codes SET created_at = created_at - INTERVAL '61 seconds' WHERE ip_address = '10.0.5.1'`);
    statuses.push((await client.post('/api/auth/forgot-password', { email: 'flood@acifac.local' })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('sessions: 20 minutes without activity ends the session on the server', { skip }, async () => {
  await createLoginUser('idleuser', 'idle@acifac.local', 'IdlePass1!');
  const browser = new Client('10.0.6.1');
  assert.equal((await browser.post('/api/auth/login', { usernameOrEmail: 'idleuser', password: 'IdlePass1!' })).status, 200);
  const token = browser.cookies.get('session_token');
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(token).digest('hex');
  const setIdle = (minutes) => pool.query(`UPDATE sessions SET last_activity_at = NOW() - make_interval(mins => $2) WHERE token_digest = $1`, [digest, minutes]);
  const idleSeconds = async () => (await pool.query(`SELECT EXTRACT(EPOCH FROM NOW() - last_activity_at)::int AS s FROM sessions WHERE token_digest = $1`, [digest])).rows[0].s;

  const status = await browser.get('/api/auth/session');
  assert.equal(status.status, 200);
  assert.equal(status.data.idleTimeoutSeconds, 1200);
  assert.ok(status.data.idleExpiresInSeconds > 1190);

  // Background checks (passive) and the live-update stream do not count as activity.
  await setIdle(10);
  const passive = await browser.get('/api/auth/session', { headers: { 'X-Session-Activity': 'passive' } });
  assert.ok(passive.data.idleExpiresInSeconds <= 600 && passive.data.idleExpiresInSeconds > 590, String(passive.data.idleExpiresInSeconds));
  const stream = new AbortController();
  const events = await fetch(`${baseUrl}/api/events`, { headers: { Cookie: browser.cookie }, signal: stream.signal });
  assert.ok([200, 204].includes(events.status), String(events.status));
  stream.abort();
  assert.ok(await idleSeconds() >= 599, 'still idle');

  // Real requests do count, even at 19 minutes.
  await setIdle(19);
  assert.equal((await browser.get('/api/auth/me')).status, 200);
  assert.ok(await idleSeconds() < 5, 'activity recorded');

  // 20 minutes idle: refused, cookie cleared, session revoked and recorded.
  await setIdle(21);
  const expired = await browser.get('/api/notifications');
  assert.equal(expired.status, 401);
  assert.equal(expired.data.code, 'SESSION_IDLE_TIMEOUT');
  assert.equal(expired.data.message, 'Your session expired because of inactivity. Please log in again.');
  assert.equal(browser.cookies.has('session_token'), false, 'cookie cleared');
  assert.ok((await pool.query('SELECT revoked_at FROM sessions WHERE token_digest = $1', [digest])).rows[0].revoked_at);
  const expiries = `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'SESSION_EXPIRED' AND user_name_snapshot = 'idleuser'`;
  assert.equal((await pool.query(expiries)).rows[0].n, 1);

  // A refresh (or a copy of the old cookie) cannot bring it back.
  const stale = new Client('10.0.6.1');
  for (const url of ['/api/auth/me', '/api/auth/session', '/api/notifications']) {
    stale.cookies.set('session_token', token);
    assert.equal((await stale.get(url)).status, 401, url);
  }
  assert.equal((await pool.query(expiries)).rows[0].n, 1, 'recorded once');
});

test('password reset: members without a login email use the email on their member record', { skip }, async () => {
  const { hashPassword } = await import('../src/utils/password.js');
  const member = await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone, address, membership_date, share_capital, status, farm_area_ha, date_of_birth)
     VALUES ('ACIFAC-2026-900', 'Rosa', 'Reyes', 'rosa@example.com', '09170000900', 'Purok 9', '2026-01-15', 0, 'active', 1, '1990-01-01') RETURNING id`
  );
  await pool.query(
    `INSERT INTO users (member_id, username, email, password_hash, role, account_status) VALUES ($1, 'rosa', NULL, $2, 'MEMBER', 'ACTIVE')`,
    [member.rows[0].id, await hashPassword('RosaPass1!')]
  );
  const browser = new Client('10.0.7.1');
  const textsBefore = sentTexts.length;
  assert.equal((await browser.post('/api/auth/forgot-password', { email: 'rosa@example.com' })).status, 200);
  const { code } = await nextResetCode('rosa@example.com');
  assert.equal((await browser.post('/api/auth/verify-reset-code', { email: 'rosa@example.com', code })).status, 200);
  assert.equal((await browser.post('/api/auth/reset-password', { newPassword: 'RosaNew1!', confirmPassword: 'RosaNew1!' })).status, 200);
  assert.equal((await new Client('10.0.7.2').post('/api/auth/login', { usernameOrEmail: 'ACIFAC-2026-900', password: 'RosaNew1!' })).status, 200, 'member number sign-in with the new password');
  assert.equal(sentTexts.length, textsBefore, 'a code asked for by email is only emailed');
});

test('password reset: by mobile number, texted to the number on the member record', { skip }, async () => {
  const phoneBrowser = new Client('10.0.8.1');
  assert.equal((await phoneBrowser.post('/api/auth/forgot-password', { phone: '0917-000' })).status, 400);

  // Any format of the number works, and an unknown number gets the same reply.
  const known = await phoneBrowser.post('/api/auth/forgot-password', { phone: '+63 917 000 0900' });
  const unknown = await new Client('10.0.8.2').post('/api/auth/forgot-password', { phone: '09170000999' });
  assert.equal(known.status, 200, JSON.stringify(known.data));
  assert.deepEqual(unknown.data, known.data);
  assert.equal(known.data.message, 'If an account with that mobile number exists, a verification code has been sent.');
  const text = await waitForText((entry) => entry.recipients[0] === '+639170000900');
  const code = /code: (\d{6})\./.exec(text.message)[1];
  assert.equal(text.message, `ACIFAC password reset code: ${code}. It expires in 10 minutes. Do not share it. If you did not ask for it, ignore this text.\n- ACIFAC Administrator`);
  assert.ok(!sentTexts.some((entry) => entry.recipients[0] === '+639170000999'), 'nothing is texted to unknown numbers');
  assert.ok(!sentEmails.some((mail) => mail.to === 'rosa@example.com' && mail.text.includes(code)), 'a code asked for by number is only texted');

  assert.equal((await phoneBrowser.post('/api/auth/verify-reset-code', { email: 'rosa@example.com', code })).status, 400, 'the code belongs to the number, not the email');
  assert.equal((await phoneBrowser.post('/api/auth/verify-reset-code', { phone: '09170000900', code })).status, 200);
  assert.equal((await phoneBrowser.post('/api/auth/reset-password', { newPassword: 'RosaText1!', confirmPassword: 'RosaText1!' })).status, 200);
  assert.equal((await new Client('10.0.8.3').post('/api/auth/login', { usernameOrEmail: 'rosa', password: 'RosaText1!' })).status, 200);

  // A number shared by two accounts resets neither: the code could not say which.
  const { hashPassword } = await import('../src/utils/password.js');
  const sibling = await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone, address, membership_date, share_capital, status, farm_area_ha, date_of_birth)
     VALUES ('ACIFAC-2026-901', 'Ramon', 'Reyes', 'ramon@example.com', '0917 000 0900', 'Purok 9', '2026-01-15', 0, 'active', 1, '1988-01-01') RETURNING id`
  );
  await pool.query(`INSERT INTO users (member_id, username, email, password_hash, role, account_status) VALUES ($1, 'ramon', NULL, $2, 'MEMBER', 'ACTIVE')`, [sibling.rows[0].id, await hashPassword('RamonPass1!')]);
  await pool.query(`UPDATE password_reset_codes SET created_at = created_at - INTERVAL '61 seconds'`);
  const shared = await new Client('10.0.8.4').post('/api/auth/forgot-password', { phone: '09170000900' });
  const textsAfter = sentTexts.length;
  assert.deepEqual(shared.data, known.data);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentTexts.length, textsAfter, 'nothing is texted to a shared number');
});

test('change password in settings: a code by text or email instead of the current password', { skip }, async () => {
  const { hashPassword } = await import('../src/utils/password.js');
  const created = await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone, address, membership_date, share_capital, status, farm_area_ha, date_of_birth)
     VALUES ('ACIFAC-2026-902', 'Lito', 'Cruz', 'lito@example.com', '0918-555-0902', 'Purok 2', '2026-01-15', 0, 'active', 1, '1985-01-01') RETURNING id`
  );
  await pool.query(`INSERT INTO users (member_id, username, email, password_hash, role, account_status) VALUES ($1, 'lito', NULL, $2, 'MEMBER', 'ACTIVE')`, [created.rows[0].id, await hashPassword('LitoPass1!')]);
  const lito = new Client('10.0.9.1');
  assert.equal((await lito.post('/api/auth/login', { usernameOrEmail: 'lito', password: 'LitoPass1!' })).status, 200);
  const me = (await lito.get('/api/auth/me')).data.user;
  assert.deepEqual([me.phone, me.sms_available, me.notification_email], ['0918-555-0902', true, 'lito@example.com']);

  // By text: the code goes to the number on the account, never one sent in the request.
  const texted = await lito.post('/api/auth/change-password/code', { channel: 'sms', phone: '09170000999' });
  assert.equal(texted.status, 200, JSON.stringify(texted.data));
  assert.equal(texted.data.sentTo, '0918 ••• 0902');
  const text = await waitForText((entry) => entry.recipients[0] === '+639185550902');
  const code = /code: (\d{6})\./.exec(text.message)[1];
  assert.equal((await lito.post('/api/auth/change-password/code', { channel: 'sms' })).data.code, 'RESET_CODE_COOLDOWN');

  assert.equal((await lito.post('/api/auth/change-password', { newPassword: 'LitoNew1!', confirmPassword: 'LitoNew1!' })).status, 400, 'a code or the current password is required');
  const wrong = await lito.post('/api/auth/change-password', { code: code === '000000' ? '111111' : '000000', newPassword: 'LitoNew1!', confirmPassword: 'LitoNew1!' });
  assert.deepEqual([wrong.status, wrong.data.code], [400, 'RESET_CODE_INVALID']);
  const same = await lito.post('/api/auth/change-password', { code, newPassword: 'LitoPass1!', confirmPassword: 'LitoPass1!' });
  assert.equal(same.status, 400, 'the new password must differ');
  const changed = await lito.post('/api/auth/change-password', { code, newPassword: 'LitoNew1!', confirmPassword: 'LitoNew1!' });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await lito.get('/api/auth/me')).status, 401, 'every session ends');
  assert.equal((await lito.post('/api/auth/login', { usernameOrEmail: 'lito', password: 'LitoNew1!' })).status, 200);

  // By email, to the member record's address. A used code does not work twice.
  await pool.query(`UPDATE password_reset_codes SET created_at = created_at - INTERVAL '61 seconds'`);
  const emailed = await lito.post('/api/auth/change-password/code', { channel: 'email' });
  assert.deepEqual([emailed.status, emailed.data.sentTo], [200, 'l•••@example.com']);
  const { code: emailCode } = await nextResetCode('lito@example.com');
  assert.equal((await lito.post('/api/auth/change-password', { code, newPassword: 'LitoNew2!', confirmPassword: 'LitoNew2!' })).data.code, 'RESET_CODE_INVALID', 'the texted code was replaced');
  assert.equal((await lito.post('/api/auth/change-password', { code: emailCode, newPassword: 'LitoNew2!', confirmPassword: 'LitoNew2!' })).status, 200);
  assert.equal((await new Client('10.0.9.2').post('/api/auth/login', { usernameOrEmail: 'lito', password: 'LitoNew2!' })).status, 200);

  const actions = (await pool.query(`SELECT action, details FROM audit_logs WHERE user_id = (SELECT id FROM users WHERE username = 'lito') ORDER BY id`)).rows;
  assert.deepEqual(actions.filter((row) => row.action === 'PASSWORD_CHANGED').map((row) => row.details.method), ['code', 'code']);
  assert.ok(actions.some((row) => row.action === 'PASSWORD_CHANGE_CODE_SENT' && row.details.channel === 'sms'));
});
