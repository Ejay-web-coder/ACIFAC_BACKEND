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
// What the stub AI answers for the machinery recommendations, and the figures it was sent.
let stubRecommendations = {};
const recommendationRequests = [];
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

// AI reads the applicant's valid ID (a back-to-back copy with 3 specimen
// signatures) when it is picked in Add Member or Edit Member.
async function readMemberId(client, reading, file, source = 'upload') {
  stubIdReading = reading;
  const form = new FormData();
  form.append('source', source);
  form.append('idDocument', new Blob([file], { type: 'image/png' }), 'id.png');
  return client.request('POST', '/api/members/id-reading', { form });
}

// The applicant's ID as AI reads it: in the name and birthday on the form.
const applicantId = (fields) => ({ ...BORROWER_ID, name: `${fields.first_name} ${fields.last_name}`.toUpperCase(), dateOfBirth: fields.date_of_birth, idNumber: '', address: '' });

// A member as Add Member sends it, with the reading of the ID file. A file
// that is not a picture or PDF is refused before AI reads it.
async function memberForm(overrides = {}, file = PNG, signatures = 0) {
  const form = new FormData();
  const fields = {
    first_name: 'Juan', last_name: 'Dela Cruz', email: 'juan@example.com', phone: '09171234567', address: 'Purok 1, Amnay',
    membership_date: '2026-01-15', share_capital: '1000', farm_area_ha: '2', date_of_birth: '1980-05-20', status: 'active', ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) {
    const read = await readMemberId(admin, applicantId(fields), file);
    if (read.status === 201) form.append('id_document_reading', String(read.data.readingId));
    form.append('idDocument', new Blob([file], { type: 'image/png' }), 'id.png');
  }
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
      if (prompt.startsWith('You advise the officers of ACIFAC')) recommendationRequests.push(JSON.parse(Buffer.concat(chunks).toString()).messages[1].content);
      const answer = prompt.startsWith('You check the valid ID that') ? stubIdReading : prompt.includes('2x2 ID picture that an applicant submits') ? stubPhotoReading
        : prompt.startsWith('You advise the officers of ACIFAC') ? stubRecommendations : stubAnalysis;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  }).listen(0);
  process.env.OCR_AI_URL = `http://127.0.0.1:${stubServer.address().port}/v1/chat/completions`;
  // Texts go to the stub, at any hour and without the pause between them.
  Object.assign(process.env, {
    TEXTBEE_API_URL: `http://127.0.0.1:${stubServer.address().port}/textbee`, TEXTBEE_API_KEY: 'test-textbee-key', TEXTBEE_DEVICE_ID: 'test-device',
    SMS_SEND_HOURS: '0-24', SMS_SEND_GAP_MS: '0',
    // Loan payments can be recorded whenever the tests run; the office-hours test narrows it.
    LOAN_PAYMENT_HOURS: 'Mon-Sun 00:00-24:00',
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
  const invalidFile = await admin.request('POST', '/api/members', { form: await memberForm({}, Buffer.from('not an image')) });
  assert.equal(invalidFile.status, 400);
  const created = await admin.request('POST', '/api/members', { form: await memberForm({}, PNG, 3) });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  state.memberId = created.data.data.id;
  assert.equal(created.data.data.signature_count, 3);
  assert.match(created.data.data.member_number, /^ACIFAC-\d{4}-001$/);
  assert.equal(created.data.data.share_capital, 1000);

  const duplicate = await admin.request('POST', '/api/members', { form: await memberForm({ email: 'JUAN@example.com' }) });
  assert.equal(duplicate.status, 409);

  const second = await admin.request('POST', '/api/members', { form: await memberForm({ first_name: 'Maria', last_name: 'Santos', email: 'maria@example.com', date_of_birth: '1985-01-01', share_capital: '0' }) });
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
  // A member without signatures gets them in order. A new valid ID is read by AI first, like in Add Member.
  const firstForm = new FormData();
  firstForm.append('signature3', new Blob([PNG], { type: 'image/png' }), 's.png');
  stubIdReading = { ...BORROWER_ID, name: 'MARIA SANTOS', dateOfBirth: '1985-01-01' };
  const jpegRead = new FormData();
  jpegRead.append('idDocument', new Blob([JPEG], { type: 'image/jpeg' }), 'new-id.jpg');
  firstForm.append('id_document_reading', String((await admin.request('POST', '/api/members/id-reading', { form: jpegRead })).data.readingId));
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

  // Termination of membership: automatic, voluntary, or involuntary for one of the causes.
  const terminate = (body) => admin.patch(`/api/members/${state.secondMemberId}/archive`, body);
  assert.equal((await terminate({})).status, 400, 'the kind of termination is required');
  assert.equal((await terminate({ terminationType: 'expelled' })).status, 400);
  const noCause = await terminate({ terminationType: 'involuntary' });
  assert.equal(noCause.status, 400);
  assert.match(noCause.data.message, /cause of the involuntary termination/);
  const archived = await terminate({ terminationType: 'involuntary', cause: 'failedObligations' });
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  const archivedList = await admin.get('/api/members/archived');
  assert.equal(archivedList.data.data[0].archived_by_username, 'testadmin');
  assert.deepEqual({ ...archivedList.data.data[0].termination, date: 'today' }, { type: 'involuntary', cause: 'failedObligations', date: 'today' });
  const terminated = (await admin.get(`/api/members/${state.secondMemberId}`)).data.data.additional_info;
  assert.equal(terminated.separationDate, terminated.termination.date, 'the Separation date on the form is the termination date');
  const again = await terminate({ terminationType: 'voluntary' });
  assert.equal(again.status, 409);
  const restored = await admin.patch(`/api/members/${state.secondMemberId}/restore`);
  assert.equal(restored.status, 200);
  const reinstated = (await admin.get(`/api/members/${state.secondMemberId}`)).data.data.additional_info || {};
  assert.equal(reinstated.termination, undefined);
  assert.equal(reinstated.separationDate, undefined);

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

test('members: Add Member needs the applicant ID as a back-to-back copy with 3 signatures', { skip }, async () => {
  const fields = { first_name: 'Lito', last_name: 'Ramos', email: 'lito@example.com', date_of_birth: '1979-08-09', id_number: '5555-6666-7777' };
  const reading = { ...applicantId(fields), idNumber: '5555-6666-7777' };
  const post = (file, readingId, extra = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ phone: '09170001111', address: 'Purok 4, Amnay', membership_date: '2026-02-01', status: 'active', ...fields, ...extra })) form.append(key, value);
    if (readingId !== undefined) form.append('id_document_reading', String(readingId));
    form.append('idDocument', new Blob([file], { type: 'image/png' }), 'id.png');
    return admin.request('POST', '/api/members', { form });
  };

  // Only admins have an applicant's ID read.
  assert.equal((await readMemberId(member, reading, idFile())).status, 403);

  // An ID that AI has not read, or not this file: refused.
  const file = idFile();
  const unread = await post(file);
  assert.equal(unread.status, 400);
  assert.match(unread.data.message, /AI has not read the applicant's ID/);
  const read = await readMemberId(admin, reading, file);
  assert.equal(read.status, 201, JSON.stringify(read.data));
  assert.equal(read.data.reading.signatureCount, 3);
  const swapped = await post(idFile(), read.data.readingId);
  assert.equal(swapped.status, 400);
  assert.match(swapped.data.message, /not the one AI read/);

  // Two signatures, the card itself without signatures, or someone else's ID: refused.
  for (const [wrong, message] of [
    [{ ...reading, signatureCount: 2 }, /2 specimen signatures; 3 are required/],
    [{ ...reading, photocopy: false, physicalCard: true, signatureCount: 0 }, /0 specimen signatures; 3 are required/],
    [{ ...reading, name: 'MARIA SANTOS' }, /not the applicant/],
  ]) {
    const other = idFile();
    const refused = await post(other, (await readMemberId(admin, wrong, other, 'camera')).data.readingId);
    assert.equal(refused.status, 422, JSON.stringify(refused.data));
    assert.match(refused.data.message, message);
  }

  // The form previews the checks; a birthday that differs must be confirmed.
  const differs = idFile();
  const differsRead = await readMemberId(admin, { ...reading, dateOfBirth: '1979-09-08' }, differs);
  const preview = await admin.post('/api/members/id-checks', { idReading: differsRead.data.readingId, firstName: 'Lito', lastName: 'Ramos', dateOfBirth: '1979-08-09', idNumber: '5555-6666-7777' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(Object.fromEntries(preview.data.checks.map((check) => [check.id, check.status])), { idDocument: 'pass', idMatch: 'warn' });
  const unconfirmed = await post(differs, differsRead.data.readingId);
  assert.equal(unconfirmed.status, 422);
  assert.match(unconfirmed.data.message, /Confirm that you compared the flagged ID details/);
  assert.equal((await admin.get('/api/members?search=lito')).data.data.length, 0, 'nothing was saved');
  const saved = await post(differs, differsRead.data.readingId, { acknowledge_id_warnings: 'true' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.data.signature_count, 0, 'no signatures are drawn');

  // Edit Member: a new ID is read by AI too, and must be the member's.
  const url = `/api/members/${saved.data.data.id}/documents`;
  const unreadForm = new FormData();
  unreadForm.append('idDocument', new Blob([idFile()], { type: 'image/png' }), 'id.png');
  assert.equal((await admin.request('POST', url, { form: unreadForm })).status, 400);
  for (const [replacementReading, status] of [[{ ...reading, name: 'MARIA SANTOS' }, 422], [reading, 200]]) {
    const replacement = idFile();
    const form = new FormData();
    form.append('id_document_reading', String((await readMemberId(admin, replacementReading, replacement)).data.readingId));
    form.append('idDocument', new Blob([replacement], { type: 'image/png' }), 'id.png');
    const replaced = await admin.request('POST', url, { form });
    assert.equal(replaced.status, status, JSON.stringify(replaced.data));
  }

  // This member is not part of the counts in the tests that follow.
  await pool.query('DELETE FROM members WHERE id = $1', [saved.data.data.id]);
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

test('savings: members with savings, history with the running balance, withdrawals', { skip }, async () => {
  // The member has 2,500.50 (Feb 1) and 30,000 (Feb 2) from the test above.
  const withdraw = (body) => admin.post('/api/members/savings/withdrawals', { memberId: state.memberId, paymentMethod: 'Cash', ...body });
  // PHP 500 always stays in savings.
  const tooMuch = await withdraw({ amount: '40000', date: '2026-02-03' });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.data.message, /^PHP 500\.00 must stay in the member's savings\. With a balance of PHP 32,500\.50, the most that can be withdrawn is PHP 32,000\.50\.$/);
  assert.equal((await withdraw({ amount: '32500.50', date: '2026-02-03' })).status, 400, 'not all of it');
  assert.equal((await withdraw({ amount: '32000.51', date: '2026-02-03' })).status, 400);
  // A back-dated withdrawal cannot take out money deposited later.
  const backDated = await withdraw({ amount: '3000', date: '2026-02-01' });
  assert.equal(backDated.status, 400);
  assert.match(backDated.data.message, /On 2026-02-01 the member's savings balance was only PHP 2,500\.50, and PHP 500\.00 must stay in savings/);
  assert.equal((await withdraw({ amount: '2000.51', date: '2026-02-01' })).status, 400, 'PHP 500 stays on Feb 1 too');
  assert.equal((await withdraw({ amount: '0', date: '2026-02-03' })).status, 400);
  assert.equal((await withdraw({ amount: '5', date: '2999-01-01' })).status, 400);
  assert.equal((await member.post('/api/members/savings/withdrawals', { memberId: state.memberId, amount: '5', date: '2026-02-03' })).status, 403);

  const first = await withdraw({ amount: '2000', date: '2026-02-01', reference: 'WD-1' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.memberTotal, 30500.5);
  assert.equal(first.data.data.type, 'Withdrawal');
  assert.equal((await withdraw({ amount: '10', date: '2026-02-03', reference: 'wd-1' })).status, 409);
  // Only 500.50 was left on Feb 1, so 0.50 more at most.
  assert.equal((await withdraw({ amount: '0.51', date: '2026-02-01' })).status, 400);
  const second = await withdraw({ amount: '500.50', date: '2026-02-03', notes: 'For seeds' });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(second.data.memberTotal, 30000);

  // The list of members with savings, searched by member ID or name.
  const memberNumber = (await admin.get(`/api/members/${state.memberId}`)).data.data.member_number;
  const byId = await admin.get(`/api/members/savings/members?search=${encodeURIComponent(memberNumber)}`);
  assert.equal(byId.status, 200, JSON.stringify(byId.data));
  const row = byId.data.data.find((item) => item.id === state.memberId);
  assert.deepEqual({ balance: row.balance, deposits: row.deposits, withdrawals: row.withdrawals, transactions: row.transactions }, { balance: 30000, deposits: 32500.5, withdrawals: 2500.5, transactions: 4 });
  assert.equal(row.lastTransactionDate, '2026-02-03');
  assert.ok((await admin.get('/api/members/savings/members?search=dela%20cruz')).data.data.some((item) => item.id === state.memberId));
  assert.ok((await admin.get('/api/members/savings/members?search=Cruz,%20Juan')).data.data.some((item) => item.id === state.memberId), 'last name, first name');
  assert.equal((await admin.get('/api/members/savings/members?search=nobody-here')).data.data.length, 0);
  assert.ok(!(await admin.get('/api/members/savings/members')).data.data.some((item) => item.id === state.secondMemberId), 'members without savings are not listed');
  assert.equal((await member.get('/api/members/savings/members')).status, 403);

  // One member's history: newest first, with the balance after each entry.
  const history = await admin.get(`/api/members/${state.memberId}/savings`);
  assert.equal(history.status, 200, JSON.stringify(history.data));
  assert.deepEqual(history.data.summary, { balance: 30000, deposits: 32500.5, withdrawals: 2500.5, transactions: 4, maintainingBalance: 500, withdrawable: 29500 });
  assert.deepEqual(history.data.data.map((entry) => [entry.date, entry.type, entry.amount, entry.balance]), [
    ['2026-02-03', 'Withdrawal', 500.5, 30000],
    ['2026-02-02', 'Deposit', 30000, 30500.5],
    ['2026-02-01', 'Withdrawal', 2000, 500.5],
    ['2026-02-01', 'Deposit', 2500.5, 2500.5],
  ]);
  assert.equal(history.data.data[0].notes, 'For seeds');
  assert.equal(history.data.member.memberNumber, memberNumber);
  assert.equal((await admin.get('/api/members/999999/savings')).status, 404);
  assert.equal((await member.get(`/api/members/${state.memberId}/savings`)).status, 403);

  // Totals everywhere are deposits minus withdrawals.
  const all = await admin.get('/api/members/savings');
  assert.equal(all.data.summary.totalAmount, 30000);
  assert.equal(all.data.summary.withdrawals, 2500.5);
  assert.ok(all.data.data.some((entry) => entry.type === 'Withdrawal' && entry.reference === 'WD-1'));
  const mine = await member.get('/api/members/me');
  assert.equal(mine.data.data.savings.total, 30000);
  assert.deepEqual([mine.data.data.savings.transactions[0].type, mine.data.data.savings.transactions[0].balance], ['Withdrawal', 30000]);
  const audit = await pool.query(`SELECT new_values FROM audit_logs WHERE action = 'SAVINGS_WITHDRAWAL_CREATED' ORDER BY id`);
  assert.deepEqual(audit.rows.map((r) => r.new_values.total_savings), ['30500.50', '30000.00']);
  const analytics = await admin.get('/api/admin/analytics');
  assert.equal(analytics.status, 200, JSON.stringify(analytics.data));

  // A member with less than PHP 500 cannot withdraw; a terminated member gets all of it.
  const other = (body) => admin.post('/api/members/savings/withdrawals', { memberId: state.secondMemberId, paymentMethod: 'Cash', date: '2026-02-05', ...body });
  assert.equal((await admin.post('/api/members/savings', { memberId: state.secondMemberId, amount: '450', date: '2026-02-05' })).status, 201);
  assert.match((await other({ amount: '1' })).data.message, /the most that can be withdrawn is PHP 0\.00/);
  assert.deepEqual((await admin.get(`/api/members/${state.secondMemberId}/savings`)).data.summary, { balance: 450, deposits: 450, withdrawals: 0, transactions: 1, maintainingBalance: 500, withdrawable: 0 });
  assert.equal((await admin.patch(`/api/members/${state.secondMemberId}/archive`, { terminationType: 'involuntary', cause: 'failedObligations' })).status, 200);
  assert.deepEqual((await admin.get(`/api/members/${state.secondMemberId}/savings`)).data.summary, { balance: 450, deposits: 450, withdrawals: 0, transactions: 1, maintainingBalance: 0, withdrawable: 450 });
  assert.match((await other({ amount: '450.01' })).data.message, /more than the member's savings balance of PHP 450\.00/);
  const payout = await other({ amount: '450', notes: 'Membership terminated' });
  assert.equal(payout.status, 201, JSON.stringify(payout.data));
  assert.equal(payout.data.memberTotal, 0);
  assert.equal((await admin.patch(`/api/members/${state.secondMemberId}/restore`)).status, 200);
});

test('auto refresh: browsers poll which tables changed, and only see their own', { skip }, async () => {
  assert.equal((await new Client().get('/api/events/changes')).status, 401);
  const start = await admin.get('/api/events/changes');
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.deepEqual(start.data.changes, [], 'without a cursor it only says where to start');
  const cursor = start.data.cursor;
  const memberStart = (await member.get('/api/events/changes')).data.cursor;
  assert.equal(memberStart, cursor);

  // A deposit for the other member: the admin sees it, the member does not.
  const saved = await admin.post('/api/members/savings', { memberId: state.secondMemberId, amount: '50', date: '2026-03-01' });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const after = (response) => response.data.changes.filter((change) => BigInt(change.id) > BigInt(cursor));
  const adminPoll = await admin.get(`/api/events/changes?after=${cursor}`);
  assert.ok(after(adminPoll).some((change) => change.table === 'savings_transactions'), JSON.stringify(adminPoll.data));
  assert.ok(BigInt(adminPoll.data.cursor) > BigInt(cursor));
  const memberPoll = await member.get(`/api/events/changes?after=${memberStart}`);
  assert.ok(!after(memberPoll).some((change) => change.table === 'savings_transactions'), 'another member\'s savings stay private');

  // The member's own deposit reaches them.
  const own = await admin.post('/api/members/savings', { memberId: state.memberId, amount: '25', date: '2026-03-01' });
  assert.equal(own.status, 201);
  const mine = await member.get(`/api/events/changes?after=${memberPoll.data.cursor}`);
  assert.ok(mine.data.changes.some((change) => change.table === 'savings_transactions' && BigInt(change.id) > BigInt(memberPoll.data.cursor)), JSON.stringify(mine.data));
  // Recent changes come again with the same ids, so a change that committed late is not missed.
  const again = await member.get(`/api/events/changes?after=${mine.data.cursor}`);
  const ids = new Set(mine.data.changes.map((change) => change.id));
  assert.ok(again.data.changes.some((change) => ids.has(change.id)));
  assert.equal(again.data.cursor, mine.data.cursor);
  assert.equal((await admin.get('/api/events/changes?after=abc')).data.changes.length, 0);
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

test('machinery: the office rents to a non-member by name only', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const today = todayDateOnly();
  const plus = (days) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const pump = (await admin.get('/api/machinery')).data.machinery.find((row) => row.id === 'M-003');
  const base = { machineryId: pump.id, clientCategory: 'non_member', startDate: plus(20), endDate: plus(22), purpose: 'Irrigation' };

  assert.equal((await admin.post('/api/machinery/requests', { ...base, clientName: '   ' })).status, 400, 'a name is required');
  assert.equal((await admin.post('/api/machinery/requests', { ...base, clientCategory: 'guest', clientName: 'Rosa Reyes' })).status, 400);
  assert.equal((await member.post('/api/machinery/requests', { ...base, clientName: 'Rosa Reyes' })).status, 403, 'members book only for themselves');
  assert.equal((await admin.post('/api/machinery/requests', { ...base, clientCategory: 'member', clientName: 'Rosa Reyes' })).status, 400, 'a member rental still needs the member');

  const notesBefore = (await pool.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE type IN ('rental_approved', 'rental_declined')`)).rows[0].count;
  const mailsBefore = sentEmails.length;
  const created = await admin.post('/api/machinery/requests', { ...base, clientName: 'Rosa Reyes', memberDatabaseId: state.memberId });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const request = created.data.request;
  assert.deepEqual([request.clientCategory, request.memberName, request.memberId, request.memberDatabaseId], ['non_member', 'Rosa Reyes', null, null], 'the member ID sent along is ignored');
  assert.equal(Number(request.rentalFee), Number(pump.dailyFee) * 2, 'the same daily fee as members');

  assert.equal((await admin.patch(`/api/machinery/requests/${request.id}`, { status: 'approved' })).status, 200);
  const data = (await admin.get('/api/machinery')).data;
  assert.equal(data.requests.find((row) => row.id === request.id).status, 'approved');
  const operation = data.operations.find((row) => row.rentalRequestId === request.id);
  assert.deepEqual([operation.clientCategory, operation.memberName, operation.memberId, operation.status], ['non_member', 'Rosa Reyes', null, 'scheduled']);
  // The dates are booked for everyone, and nobody's account is notified or emailed.
  assert.equal((await member.post('/api/machinery/requests', { machineryId: pump.id, startDate: plus(21), endDate: plus(21), purpose: 'x' })).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE type IN ('rental_approved', 'rental_declined')`)).rows[0].count, notesBefore);
  assert.equal(sentEmails.length, mailsBefore);
  assert.ok(!(await member.get('/api/members/me')).data.data.rentalRequests.some((row) => row.id === request.id), 'not in any member\'s history');
  const audit = (await pool.query(`SELECT description FROM audit_logs WHERE entity_type = 'rental_request' AND entity_id = $1 ORDER BY id`, [String(request.id)])).rows.map((row) => row.description);
  assert.deepEqual(audit, [`Rental request for ${pump.name} by Rosa Reyes (non-member)`, 'Rental request approved for Rosa Reyes (non-member)']);

  // The database itself keeps the two kinds apart.
  await assert.rejects(pool.query(`UPDATE rental_requests SET member_id = $1 WHERE id = $2`, [state.memberId, request.id]), /rental_request_client_valid/);
  await assert.rejects(pool.query(`UPDATE machinery_operations SET member_name = ' ' WHERE id = $1`, [operation.id]), /machinery_operation_client_valid/);
});

test('machinery services: dated rates, fees, payments, expenses and the PhilMech report', { skip }, async () => {
  // Seeded by sql/017 and sql/038: per-service machines stay out of the per-day booking.
  const fleet = (await admin.get('/api/machinery')).data.machinery;
  const tractor = fleet.find((row) => row.name === 'Hand Tractor 2');
  const harvester = fleet.find((row) => row.name === 'Harvester' && row.pricingMode === 'per_service');
  // ACIFAC's fleet: 2 harvesters, 2 hand tractors, 2 rotavators, a water pump and a rice thresher.
  const seeded = fleet.filter((row) => row.id <= 'M-008').map((row) => [row.id, row.name, row.pricingMode]);
  assert.deepEqual(seeded, [
    ['M-001', 'Hand Tractor (Kubota)', 'per_day'], ['M-002', 'Rice Thresher', 'per_day'], ['M-003', 'Water Pump', 'per_day'], ['M-004', 'Rotavator', 'per_day'],
    ['M-005', 'Harvester', 'per_service'], ['M-006', 'Hand Tractor 2', 'per_service'], ['M-007', 'Harvester 2', 'per_service'], ['M-008', 'Rotavator 2', 'per_day'],
  ]);
  const harvester2 = fleet.find((row) => row.id === 'M-007');
  const rotavator2 = fleet.find((row) => row.id === 'M-008');
  assert.deepEqual([harvester2.acquisitionDate, harvester2.condition, harvester2.deliveryDate, harvester2.parentMachineryId], ['2026-10-09', 'operational', null, null]);
  assert.deepEqual([rotavator2.acquisitionDate, Number(rotavator2.dailyFee), rotavator2.parentMachineryId], ['2026-10-09', 700, null]);
  const harvester2Rates = (await admin.get('/api/machinery/M-007/rates')).data.rates;
  assert.deepEqual(harvester2Rates.map((rate) => [rate.serviceType, rate.unit, rate.memberRate, rate.nonMemberRate, rate.effectiveFrom, rate.effectiveTo]),
    [['Harvesting', 'per_100_bags', '10.00', '12.00', '2026-10-09', null]], 'the first harvester\'s rates, from the day the second was acquired');
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

test('machinery: the PhilMech report form is saved per cropping', { skip }, async () => {
  const url = '/api/machinery/reports/philmech/form';
  assert.equal((await member.get(`${url}?croppingPeriod=1st&year=2026`)).status, 403);

  // sql/028 records the form ACIFAC submitted for the 1st cropping of 2026.
  const first = await admin.get(`${url}?croppingPeriod=1st&year=2026`);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.form.saved, true);
  assert.equal(first.data.form.contactNumber, '09557733522');
  assert.deepEqual([first.data.form.fromMonth, first.data.form.toMonth, first.data.form.submissionDate], [1, 7, '2026-09-25']);
  assert.deepEqual([first.data.form.palayPriceFresh, first.data.form.palayPriceDry], ['14.00', '24.00']);
  assert.deepEqual([first.data.form.landPreparation, first.data.form.harvestingThreshing], [true, true]);

  // A cropping without a form starts from the last form's header and signatories, nothing else.
  const second = await admin.get(`${url}?croppingPeriod=2nd&year=2026`);
  assert.equal(second.data.form.saved, false);
  assert.equal(second.data.form.fcaName, first.data.form.fcaName);
  assert.equal(second.data.form.preparedByPosition, 'SECRETARY');
  assert.deepEqual([second.data.form.palayPriceFresh, second.data.form.submissionDate, second.data.form.problems], [null, null, []]);

  const form = {
    croppingPeriod: '2nd', year: 2026, fromMonth: 8, toMonth: 12, submissionDate: '2027-01-15', fcaName: 'ACIFAC', landPreparation: true, harvestingThreshing: false,
    palayPriceFresh: '15.5', palayPriceDry: '', problems: ['unpaid_collectibles', 'frequent_breakdown', 'unpaid_collectibles'], technicalOthers: 'Blades wear out',
    suggestedSolutions: 'Collect before the next cropping', preparedBy: 'Juan', preparedByPosition: 'Secretary', approvedBy: 'Pedro', approvedByPosition: 'Chairman/President',
  };
  assert.equal((await admin.put(url, { ...form, problems: ['made_up'] })).status, 400);
  assert.equal((await admin.put(url, { ...form, fromMonth: 9, toMonth: 8 })).status, 400);
  assert.equal((await admin.put(url, { ...form, toMonth: null })).status, 400);
  assert.equal((await admin.put(url, { ...form, palayPriceFresh: '-1' })).status, 400);
  const saved = await admin.put(url, form);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.form.saved, true);
  assert.deepEqual(saved.data.form.problems, ['frequent_breakdown', 'unpaid_collectibles'], 'each box once, in the order of the paper form');
  assert.deepEqual([saved.data.form.palayPriceFresh, saved.data.form.palayPriceDry], ['15.50', null]);
  assert.equal(saved.data.form.submissionDate, '2027-01-15', 'the date of submission may be ahead');

  assert.equal((await admin.put(url, { ...form, problems: [], technicalOthers: '' })).status, 200);
  const reloaded = (await admin.get(`${url}?croppingPeriod=2nd&year=2026`)).data.form;
  assert.deepEqual([reloaded.saved, reloaded.problems, reloaded.technicalOthers, reloaded.landPreparation], [true, [], '', true]);
  assert.equal((await admin.get(`${url}?croppingPeriod=1st&year=2026`)).data.form.fcaName, first.data.form.fcaName, 'other croppings are untouched');
  const audits = await pool.query(`SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'MACHINERY_REPORT_FORM_SAVED'`);
  assert.equal(audits.rows[0].count, 2);
});

test('machinery analytics: utilization, revenue and cost, alerts, downtime, ROI and recommendations', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const today = todayDateOnly();
  const plus = (days) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  // A machine owned for 101 days, with an overdue maintenance date and a purchase cost.
  assert.equal((await admin.post('/api/machinery', { name: 'Analytics Tractor', type: 'Tractor', dailyFee: '1000', acquisitionDate: plus(-100), purchaseCost: '-5' })).status, 400);
  const created = await admin.post('/api/machinery', { name: 'Analytics Tractor', type: 'Tractor', dailyFee: '1000', acquisitionDate: plus(-100), nextMaintenance: plus(-3), purchaseCost: '200000' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.machinery.id;
  assert.equal(Number(created.data.machinery.purchaseCost), 200000);

  // A 3-day rental 10 days ago, fuel and repairs, and 2 days in maintenance.
  await pool.query(`INSERT INTO machinery_operations (machinery_id, machinery_name, member_id, member_name, purpose, start_date, end_date, duration, rental_fee, status)
                    VALUES ($1, 'Analytics Tractor', $2, 'Juan Dela Cruz', 'Plowing', $3, $4, 3, 3000, 'completed')`, [id, state.memberId, plus(-10), plus(-7)]);
  for (const [category, amount] of [['fuel', '500'], ['repair_maintenance', '2000']]) {
    const expense = await admin.post('/api/machinery/expenses', { machineryId: id, expenseDate: plus(-5), croppingPeriod: '2nd', year: Number(today.slice(0, 4)), category, amount });
    assert.equal(expense.status, 201, JSON.stringify(expense.data));
  }
  assert.equal((await admin.patch(`/api/machinery/${id}`, { status: 'maintenance' })).status, 200);
  assert.equal((await admin.patch(`/api/machinery/${id}`, { status: 'available' })).status, 200);
  await pool.query(`UPDATE audit_logs SET created_at = NOW() - CASE WHEN new_values ->> 'status' = 'maintenance' THEN INTERVAL '3 days' ELSE INTERVAL '1 day' END
                    WHERE entity_type = 'machinery' AND entity_id = $1 AND action = 'MACHINERY_UPDATED'`, [id]);

  assert.equal((await member.get(`/api/admin/analytics/machinery?from=${plus(-30)}&to=${today}`)).status, 403);
  assert.equal((await admin.get('/api/admin/analytics/machinery?from=2026-02-30&to=2026-03-01')).status, 400);
  const response = await admin.get(`/api/admin/analytics/machinery?from=${plus(-30)}&to=${today}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const data = response.data;
  const machine = data.machines.find((row) => row.id === id);
  assert.deepEqual([machine.usedDays, machine.ownedDays, machine.utilization, machine.bookings], [3, 31, 9.7, 1]);
  assert.deepEqual([machine.revenue, machine.cost, machine.net], [3000, 2500, 500]);
  assert.deepEqual(machine.costByCategory, { fuel: 500, labor: 0, repair_maintenance: 2000, other: 0 });
  assert.deepEqual([machine.downtimeDays, machine.downtimeEvents, machine.downSince], [2, 1, null]);
  assert.deepEqual(machine.alerts.map((alert) => alert.kind).sort(), ['overdue', 'repair_cost']);
  assert.equal(data.alerts[0].severity, 'high', 'the most urgent alerts come first');
  assert.ok(data.fleet.revenue >= 3000 && data.fleet.utilization !== null);
  assert.ok(data.bookings.upcoming.some((row) => row.kind === 'booking'), 'the booking approved in the machinery test is coming up');

  assert.equal(machine.roi.status, 'ok');
  assert.deepEqual([machine.roi.lifetimeRevenue, machine.roi.lifetimeCost, machine.roi.lifetimeNet], [3000, 2500, 500]);
  assert.ok(machine.roi.earnedBack > 0 && machine.roi.paybackYears > 100);
  assert.equal(data.forecast.history.length, 13);
  assert.equal(data.forecast.forecast.length, 6);
  // Used 3 of 101 days in the last 12 months while earning more than it cost: find it more work
  // (one recommendation for all such machines). Repairs are 2/3 of its revenue.
  assert.ok(data.ruleRecommendations.some((item) => item.type === 'promote' && `${item.title} ${item.reason}`.includes('Analytics Tractor (3%)')));
  assert.ok(data.ruleRecommendations.some((item) => item.machineId === id && item.type === 'maintenance' && /66\.7%/.test(item.reason)));

  // A period still to come has nothing to measure yet.
  const ahead = (await admin.get(`/api/admin/analytics/machinery?from=${plus(10)}&to=${plus(20)}`)).data;
  assert.ok(ahead.machines.every((row) => row.utilization === null && row.downtimeDays === 0));

  // The purchase cost is cleared with a blank; 0 is a machine received as a grant.
  assert.equal((await admin.patch(`/api/machinery/${id}`, { purchaseCost: '' })).data.machinery.purchaseCost, null);
  assert.equal(Number((await admin.patch(`/api/machinery/${id}`, { purchaseCost: '0' })).data.machinery.purchaseCost), 0);
  assert.equal((await admin.get(`/api/admin/analytics/machinery?from=${plus(-30)}&to=${today}`)).data.machines.find((row) => row.id === id).roi.status, 'grant');

  // AI recommendations: only known types, priorities and machines are kept.
  stubRecommendations = { summary: 'A small fleet.', recommendations: [
    { type: 'rates', priority: 'high', machineId: id, title: 'Raise the rate', reason: 'Used 9.7% of days.', impact: 'More revenue' },
    { type: 'made_up', priority: 'urgent', machineId: 'M-999', title: 'Something else', reason: 'Because.' },
    { type: 'buy', priority: 'low', title: '' },
  ] };
  const url = '/api/admin/analytics/machinery/recommendations';
  assert.equal((await member.post(url, { from: plus(-30), to: today })).status, 403);
  const advice = await admin.post(url, { from: plus(-30), to: today });
  assert.equal(advice.status, 200, JSON.stringify(advice.data));
  assert.equal(advice.data.source, 'ai');
  assert.equal(advice.data.summary, 'A small fleet.');
  assert.deepEqual(advice.data.recommendations.map(({ type, priority, machineId, machine: name }) => [type, priority, machineId, name]),
    [['rates', 'high', id, 'Analytics Tractor'], ['other', 'medium', null, null]]);
  const facts = JSON.parse(recommendationRequests.at(-1).replace(/^[^{]*/, '').replace(/ Return JSON only\.$/, ''));
  assert.equal(facts.machines.find((row) => row.id === id).last12Months.revenue, 3000);
  assert.ok(!JSON.stringify(facts).includes('Juan Dela Cruz'), 'no member names are sent to the AI');

  // When the AI is down, the rule-based recommendations are shown instead.
  stubMode = 'fail';
  try {
    const rules = (await admin.post(url, { from: plus(-30), to: today })).data;
    assert.equal(rules.source, 'rules');
    assert.match(rules.notice, /AI could not answer/);
    assert.ok(rules.recommendations.some((item) => item.machineId === id));
  } finally {
    stubMode = 'ok';
  }
});

test('kadiwa: sales decrement stock, reject overselling and race safely', { skip }, async () => {
  // A product saved before cost prices were required cannot be sold until it has one.
  assert.equal((await admin.get('/api/kadiwa')).data.summary.missingCostItems, 4);
  const noCost = await admin.post('/api/kadiwa/sales', { encoderName: 'Tester', items: [{ inventoryId: 'INV-001', quantity: '1' }] });
  assert.equal(noCost.status, 400);
  assert.match(noCost.data.message, /Set the cost price of Rice before selling it/);
  await pool.query(`UPDATE kadiwa_inventory SET cost_price = ROUND(price * 0.8, 2) WHERE cost_price IS NULL`);

  const before = await admin.get('/api/kadiwa');
  const rice = before.data.inventory.find((item) => item.id === 'INV-001');
  const startStock = Number(rice.stock);
  const sale = await admin.post('/api/kadiwa/sales', { encoderName: 'Tester', items: [{ inventoryId: 'INV-001', quantity: '5' }], totalExpenses: '10' });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(Number(sale.data.sale.groceries), 5 * Number(rice.price));
  // Net income = sold - expenses - cost of the items sold; each item keeps the cost it was sold at.
  assert.equal(Number(sale.data.sale.costOfGoods), 5 * Number(rice.costPrice));
  assert.equal(Number(sale.data.sale.netSales), 5 * Number(rice.price) - 10 - 5 * Number(rice.costPrice));
  assert.deepEqual([Number(sale.data.sale.items[0].unitCost), Number(sale.data.sale.items[0].lineCost)], [Number(rice.costPrice), 5 * Number(rice.costPrice)]);
  const today = (await admin.get('/api/kadiwa')).data.summary;
  assert.deepEqual([today.todaySales, Number(today.todayRevenue), Number(today.todayCost), Number(today.todayExpenses), Number(today.todayNetIncome), today.missingCostItems],
    [1, 5 * Number(rice.price), 5 * Number(rice.costPrice), 10, Number(sale.data.sale.netSales), 0], 'today\'s revenue, cost, expenses and net income');
  const audit = await pool.query(`SELECT new_values FROM audit_logs WHERE action = 'KADIWA_SALE_CREATED' AND entity_id = $1`, [sale.data.sale.id]);
  const logged = typeof audit.rows[0].new_values === 'string' ? JSON.parse(audit.rows[0].new_values) : audit.rows[0].new_values;
  assert.deepEqual([logged.cost_of_goods, logged.net_sales, logged.items[0].unit_cost], [sale.data.sale.costOfGoods, sale.data.sale.netSales, rice.costPrice], 'the audit log keeps the cost and the net income');
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

test('kadiwa: inventory is added as a sheet of products with size, quantity, price and cost', { skip }, async () => {
  const before = await admin.get('/api/kadiwa');
  const count = before.data.inventory.length;
  const tuna = { name: 'Century Tuna', sizeValue: '150', sizeUnit: 'g', unit: 'pc', stock: '13', price: '38', costPrice: '35', reorderLevel: '5' };
  const toyo = { name: 'Silver Swan Toyo', sizeValue: 200, sizeUnit: 'ml', unit: 'bottle', stock: 5, price: 14, costPrice: 11, reorderLevel: 2 };

  // A bad row, or the same product twice, saves nothing and names the row.
  const badUnit = await admin.post('/api/kadiwa/inventory', { items: [tuna, { ...toyo, sizeUnit: 'oz' }] });
  assert.equal(badUnit.status, 400);
  assert.match(badUnit.data.message, /^Row 2: Choose the size unit/);
  const twice = await admin.post('/api/kadiwa/inventory', { items: [tuna, { ...tuna, name: 'century tuna', sizeValue: '150.0' }] });
  assert.equal(twice.status, 400);
  assert.match(twice.data.message, /^Row 2: .*already on row 1/);
  assert.equal((await admin.get('/api/kadiwa')).data.inventory.length, count);

  const noCost = await admin.post('/api/kadiwa/inventory', { items: [tuna, toyo, { ...tuna, sizeValue: '180', costPrice: '' }] });
  assert.equal(noCost.status, 400);
  assert.match(noCost.data.message, /^Row 3: Enter the cost price/, 'the cost price is required');
  const sheet = await admin.post('/api/kadiwa/inventory', { items: [tuna, toyo, { ...tuna, sizeValue: '180', costPrice: '36' }] });
  assert.equal(sheet.status, 201, JSON.stringify(sheet.data));
  assert.equal(sheet.data.items.length, 3);
  const saved = Object.fromEntries(sheet.data.items.map((item) => [`${item.name} ${Number(item.sizeValue)}${item.sizeUnit}`, item]));
  const tunaRow = saved['Century Tuna 150g'];
  assert.equal(saved['Silver Swan Toyo 200mL'].unit, 'bottle', 'the size unit is written mL');
  assert.deepEqual([Number(tunaRow.stock), Number(tunaRow.price), Number(tunaRow.costPrice), Number(tunaRow.reorderLevel)], [13, 38, 35, 5]);
  assert.equal(Number(saved['Century Tuna 180g'].costPrice), 36);
  const audit = await pool.query(`SELECT description FROM audit_logs WHERE action = 'INVENTORY_CREATED' ORDER BY id DESC LIMIT 1`);
  assert.equal(audit.rows[0].description, 'Added 3 inventory items');

  // The same product again is refused; another size of it was not.
  const again = await admin.post('/api/kadiwa/inventory', tuna);
  assert.equal(again.status, 409);
  assert.match(again.data.message, /Century Tuna 150 g \(pc\) is already in the inventory/);

  // The stock is valued at cost, like the notebook total; at the selling price when no cost is set.
  const after = await admin.get('/api/kadiwa');
  const added = 13 * 35 + 5 * 11 + 13 * 36;
  assert.equal(Math.round(Number(after.data.summary.inventoryValue) * 100), Math.round((Number(before.data.summary.inventoryValue) + added) * 100));

  // A sale line carries the size with the name.
  const sale = await admin.post('/api/kadiwa/sales', { encoderName: 'Tester', items: [{ inventoryId: tunaRow.id, quantity: '2' }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.data.sale.items[0].name, 'Century Tuna 150 g');
  assert.equal(Number(sale.data.sale.groceries), 76);

  // Editing changes the details; a count replaces the quantity only while it is still what was opened.
  const url = `/api/kadiwa/inventory/${tunaRow.id}`;
  const edit = await admin.patch(url, { ...tuna, price: '40', costPrice: '36', stock: undefined });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.deepEqual([Number(edit.data.item.price), Number(edit.data.item.costPrice), Number(edit.data.item.stock)], [40, 36, 11]);
  const stale = await admin.patch(url, { ...tuna, price: '40', costPrice: '36', stock: '10', expectedStock: '13' });
  assert.equal(stale.status, 409);
  assert.match(stale.data.message, /is now 11 pc/);
  const counted = await admin.patch(url, { ...tuna, price: '40', costPrice: '36', stock: '10', expectedStock: '11' });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));
  assert.equal(Number(counted.data.item.stock), 10);
  const actions = await pool.query(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action IN ('INVENTORY_UPDATED', 'INVENTORY_COUNTED') ORDER BY id`, [tunaRow.id]);
  assert.deepEqual(actions.rows.map((row) => row.action), ['INVENTORY_UPDATED', 'INVENTORY_COUNTED']);

  // Renaming one size onto the other is refused.
  const clash = await admin.patch(`/api/kadiwa/inventory/${saved['Century Tuna 180g'].id}`, { ...tuna, sizeValue: '150' });
  assert.equal(clash.status, 409);
  assert.equal((await admin.patch('/api/kadiwa/inventory/INV-9999', tuna)).status, 404);
});

test('kadiwa: a product is deleted; one already sold stays for its past sales', { skip }, async () => {
  const created = await admin.post('/api/kadiwa/inventory', { items: [
    { name: 'Delete Me', unit: 'pc', stock: '5', price: '10', costPrice: '8', reorderLevel: '1' },
    { name: 'Sold Then Deleted', unit: 'pc', stock: '5', price: '20', costPrice: '15', reorderLevel: '1' },
  ] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const [unsold, sold] = ['Delete Me', 'Sold Then Deleted'].map((name) => created.data.items.find((item) => item.name === name));
  const sale = await admin.post('/api/kadiwa/sales', { sellerName: 'Tester', items: [{ inventoryId: sold.id, quantity: '2' }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  const valueBefore = Number((await admin.get('/api/kadiwa')).data.summary.inventoryValue);

  // Never sold: removed.
  const removed = await admin.request('DELETE', `/api/kadiwa/inventory/${unsold.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual([removed.data.name, removed.data.keptForPastSales], ['Delete Me', false]);
  assert.equal((await pool.query('SELECT 1 FROM kadiwa_inventory WHERE id = $1', [unsold.id])).rowCount, 0);

  // Sold: kept for its past sale, gone from the inventory and its totals.
  const archived = await admin.request('DELETE', `/api/kadiwa/inventory/${sold.id}`);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.deepEqual([archived.data.keptForPastSales, archived.data.pastSales], [true, 1]);
  const after = (await admin.get('/api/kadiwa')).data;
  assert.ok(!after.inventory.some((item) => item.id === sold.id || item.id === unsold.id), 'gone from the inventory');
  assert.equal(Math.round(Number(after.summary.inventoryValue) * 100), Math.round((valueBefore - 5 * 8 - 3 * 15) * 100), 'left out of the inventory value');
  const day = sale.data.sale.saleDate;
  const history = await admin.get(`/api/kadiwa/sales?from=${day}&to=${day}`);
  const pastSale = history.data.sales.find((entry) => entry.id === sale.data.sale.id);
  assert.ok(pastSale.items.some((item) => item.inventoryId === sold.id && item.name === 'Sold Then Deleted'), 'the past sale still shows it');

  // A deleted product cannot be sold, restocked, edited or deleted again; the same product can be added as a new one.
  assert.equal((await admin.post('/api/kadiwa/sales', { sellerName: 'Tester', items: [{ inventoryId: sold.id, quantity: '1' }] })).status, 404);
  assert.equal((await admin.patch(`/api/kadiwa/inventory/${sold.id}/restock`, { quantity: '1' })).status, 404);
  assert.equal((await admin.patch(`/api/kadiwa/inventory/${sold.id}`, { name: 'Sold Then Deleted', unit: 'pc', price: '20', costPrice: '15' })).status, 404);
  assert.equal((await admin.request('DELETE', `/api/kadiwa/inventory/${sold.id}`)).status, 404);
  const again = await admin.post('/api/kadiwa/inventory', { name: 'Sold Then Deleted', unit: 'pc', stock: '1', price: '20', costPrice: '15' });
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.notEqual(again.data.item.id, sold.id);
  const audits = await pool.query(`SELECT entity_id, new_values FROM audit_logs WHERE action = 'INVENTORY_DELETED' ORDER BY id`);
  assert.deepEqual(audits.rows.map((row) => [row.entity_id, row.new_values.kept_for_past_sales]), [[unsold.id, false], [sold.id, true]]);
});

test('kadiwa: a sale is the daily form of goods sold, reported per 15 days and per month', { skip }, async () => {
  const url = '/api/kadiwa/sales';
  const rice = (await admin.get('/api/kadiwa')).data.inventory.find((item) => item.id === 'INV-001');
  const day1 = {
    sellerName: 'Ana Seller', saleDate: '2026-09-01',
    goods: [
      { name: 'PORK', unit: 'KILO', price: '400', amount: '300' },
      { name: 'Egg', unit: 'tray', price: '260', quantity: '2' },
      { name: 'GROCERIES', amount: '745' },
      { name: 'KALABASA', unit: 'BALOT', price: '15', amount: '517' },
      { name: '  patola ', unit: 'kilo', price: '20', quantity: '5.75', category: 'Vegetables' },
    ],
    items: [{ inventoryId: 'INV-001', quantity: '1' }],
    expenses: [{ description: 'None', amount: '0' }],
  };

  // The seller, a date not ahead of today, and an amount (or quantity and price) on every line.
  // Without a seller name, the sale is recorded under the person who saves it (checked below, once valid).
  const recorder = (await pool.query(`SELECT COALESCE(NULLIF(BTRIM(full_name), ''), username) AS name FROM users WHERE username = 'testadmin'`)).rows[0].name;
  assert.match((await admin.post(url, { ...day1, saleDate: '2999-01-01' })).data.message, /cannot be in the future/);
  assert.match((await admin.post(url, { ...day1, goods: [...day1.goods, { name: 'pork', unit: 'Kilo', amount: '1' }] })).data.message, /PORK \(KILO\) is written twice/);
  const noAmount = await admin.post(url, { ...day1, goods: [{ name: 'SITAW', unit: 'BALOT', price: '15' }] });
  assert.equal(noAmount.status, 400);
  assert.match(noAmount.data.message, /^SITAW: enter the total amount, or the quantity and the price/);
  assert.match((await admin.post(url, { sellerName: 'Ana Seller', goods: [] })).data.message, /at least one good/);
  // The expenses are required with the goods: each with what it was for and the amount (0 if none).
  const { expenses: _none, ...withoutExpenses } = day1;
  assert.match((await admin.post(url, withoutExpenses)).data.message, /^Enter the expenses of the sale/);
  assert.match((await admin.post(url, { ...day1, expenses: [] })).data.message, /^Enter the expenses of the sale/);
  assert.match((await admin.post(url, { ...day1, expenses: [{ description: ' ', amount: '10' }] })).data.message, /^Expense 1: enter what it was for/);
  assert.match((await admin.post(url, { ...day1, expenses: [{ description: 'Ice', amount: '' }] })).data.message, /^Ice: enter the amount/);
  assert.match((await admin.post(url, { ...day1, expenses: [{ description: 'Ice', amount: '-5' }] })).data.message, /^Ice: enter the amount/);

  const first = await admin.post(url, day1);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const sale = first.data.sale;
  assert.deepEqual([sale.saleDate, sale.seller], ['2026-09-01', 'Ana Seller']);
  assert.match(sale.id, /^S-2026-/);
  // Groceries: egg 520 + groceries 745 + rice from the store 1 x price; vegetables: kalabasa 517 + patola 115; meat: pork 300.
  const riceCents = Math.round(Number(rice.price) * 100);
  assert.deepEqual([sale.groceries, sale.vegetables, sale.meat].map((value) => Math.round(Number(value) * 100)), [52000 + 74500 + riceCents, 51700 + 11500, 30000]);
  // Only the rice from the store has a cost price; the goods typed on the form have none.
  assert.equal(Math.round(Number(sale.costOfGoods) * 100), Math.round(Number(rice.costPrice) * 100));
  assert.equal(Math.round(Number(sale.netSales) * 100), 52000 + 74500 + riceCents + 51700 + 11500 + 30000 - Math.round(Number(rice.costPrice) * 100));
  const lines = Object.fromEntries(sale.lines.map((line) => [line.name, line]));
  assert.equal(lines.PORK.quantity, 0.75, 'quantity = amount / price when only the amount is written');
  assert.equal(lines.EGG.unit, 'TRAY');
  assert.equal(Number(lines.EGG.amount), 520, 'amount = quantity x price when the amount is left blank');
  assert.equal(Number(lines.GROCERIES.amount), 745 + Number(rice.price), 'store items are counted under GROCERIES');
  assert.equal(lines.KALABASA.quantity, 34.4667);
  assert.equal(Number(lines.PATOLA.amount), 115);
  assert.deepEqual(sale.lines.map((line) => line.name), ['PORK', 'EGG', 'GROCERIES', 'KALABASA', 'PATOLA'], 'in the order of the paper form');

  const second = await admin.post(url, { sellerName: 'Ben Seller', saleDate: '2026-09-10', totalExpenses: '999', expenses: [{ description: '  Transportation ', amount: '30' }, { description: 'Plastic bags', amount: '20.00' }], goods: [{ name: 'PORK', unit: 'KILO', price: '400', amount: '400' }, { name: 'EGG', unit: 'TRAY', price: '280', amount: '260' }] });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(Number(second.data.sale.netSales), 610, 'the expenses are the sum of the lines, not totalExpenses');
  assert.equal(Number(second.data.sale.totalExpenses), 50);
  assert.deepEqual(second.data.sale.expenses.map((line) => [line.description, Number(line.amount)]), [['Transportation', 30], ['Plastic bags', 20]]);
  const expenseAudit = await pool.query(`SELECT new_values FROM audit_logs WHERE action = 'KADIWA_SALE_CREATED' AND entity_id = $1`, [second.data.sale.id]);
  const loggedExpenses = expenseAudit.rows[0].new_values.expenses;
  assert.deepEqual(loggedExpenses, [{ description: 'Transportation', amount: '30.00' }, { description: 'Plastic bags', amount: '20.00' }], 'the audit log keeps each expense');
  const third = await admin.post(url, { sellerName: ' ', saleDate: '2026-09-20', expenses: [{ description: 'None', amount: '0' }], goods: [{ name: 'SITAW', unit: 'BALOT', price: '15', amount: '565' }] });
  assert.equal(third.status, 201, JSON.stringify(third.data));
  assert.equal(third.data.sale.seller, recorder, 'recorded under the person who saved it');

  // September 1 to 15: every good added up, like the 15-day summary.
  const half = await admin.get(`${url}?from=2026-09-01&to=2026-09-15`);
  assert.equal(half.status, 200, JSON.stringify(half.data));
  assert.deepEqual(half.data.sales.map((entry) => entry.saleDate), ['2026-09-10', '2026-09-01'], 'newest first');
  const report = Object.fromEntries(half.data.report.lines.map((line) => [line.name, line]));
  assert.deepEqual([report.PORK.quantity, Number(report.PORK.amount), Number(report.PORK.price)], [1.75, 700, 400]);
  assert.deepEqual([Number(report.EGG.price), Number(report.EGG.priceMax), Number(report.EGG.amount)], [260, 280, 780], 'a good sold at two prices shows both');
  assert.equal(report.SITAW, undefined, 'September 20 is in the second half');
  const totals = half.data.report.totals;
  assert.deepEqual([totals.sales, totals.days], [2, 2]);
  assert.equal(Math.round(Number(totals.gross) * 100), half.data.report.lines.reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0), 'the lines add up to the gross sales');
  assert.equal(Math.round(Number(totals.costOfGoods) * 100), Math.round(Number(rice.costPrice) * 100), 'the cost of the store items sold');
  assert.equal(Math.round(Number(totals.net) * 100), Math.round(Number(totals.gross) * 100) - 5000 - Math.round(Number(totals.costOfGoods) * 100));

  const month = await admin.get(`${url}?from=2026-09-01&to=2026-09-30`);
  assert.equal(month.data.report.totals.sales, 3);
  assert.equal(Number(month.data.report.lines.find((line) => line.name === 'SITAW').quantity), 37.6667);
  assert.equal((await admin.get(`${url}?from=2026-09-15&to=2026-09-01`)).status, 400);

  // The form starts from the goods with the price each was last sold at; a new good is kept.
  const goods = (await admin.get('/api/kadiwa')).data.goods;
  assert.deepEqual(goods.slice(0, 3).map((good) => good.name), ['PORK', 'EGG', 'GROCERIES']);
  assert.equal(Number(goods.find((good) => good.name === 'EGG').price), 280);
  assert.ok(goods.some((good) => good.name === 'PATOLA'));
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM kadiwa_sale_goods WHERE sale_id = $1`, [sale.id])).rows[0].count, 5);

  // Analytics plots one month day by day, with 0 on the days without a sale; longer periods month by month.
  const daily = (await admin.get('/api/admin/analytics?from=2026-09-01&to=2026-09-30')).data.sales;
  assert.equal(daily.length, 30);
  assert.deepEqual([daily[0].period, daily[29].period], ['Sep 1', 'Sep 30']);
  assert.deepEqual([daily[9].gross, daily[9].expenses, daily[9].costOfGoods, daily[9].sales, daily[9].transactions], [660, 50, 0, 610, 1], 'September 10: net income = total sold - expenses - cost');
  assert.equal(Math.round(daily[0].costOfGoods * 100), Math.round(Number(rice.costPrice) * 100), 'September 1: the rice from the store has a cost');
  assert.equal(Math.round(daily[0].sales * 100), Math.round((daily[0].gross - daily[0].expenses - daily[0].costOfGoods) * 100));
  assert.deepEqual([daily[1].sales, daily[1].expenses, daily[1].transactions], [0, 0, 0], 'September 2 has no sale');
  assert.deepEqual(daily.filter((day) => day.transactions).map((day) => day.period), ['Sep 1', 'Sep 10', 'Sep 20']);
  const quarter = (await admin.get('/api/admin/analytics?from=2026-07-01&to=2026-09-30')).data.sales;
  assert.deepEqual(quarter.map((row) => [row.period, row.transactions]), [['Sep 2026', 3]]);
  // The current month stops at today.
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const [year, monthNumber, dayNumber] = todayDateOnly().split('-').map(Number);
  const monthPrefix = todayDateOnly().slice(0, 8);
  const current = (await admin.get(`/api/admin/analytics?from=${monthPrefix}01&to=${monthPrefix}${new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()}`)).data.sales;
  assert.equal(current.length, dayNumber);
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

test('loans: payments are received on weekdays during office hours; due dates skip closed days', { skip }, async () => {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const isoDay = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  // The most recent date (today or before) on the given ISO weekday.
  const lastDay = (iso) => { const date = new Date(`${today}T00:00:00Z`); while (isoDay(date.toISOString().slice(0, 10)) !== iso) date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); };
  const pay = (paymentDate) => admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: '1', paymentDate });
  try {
    delete process.env.LOAN_PAYMENT_HOURS;
    const policy = await member.get('/api/loans/policy');
    assert.equal(policy.status, 200);
    assert.deepEqual({ days: policy.data.policy.paymentHours.days, open: policy.data.policy.paymentHours.open, close: policy.data.policy.paymentHours.close, label: policy.data.policy.paymentHours.label },
      { days: [1, 2, 3, 4, 5], open: 480, close: 1020, label: 'Monday to Friday, 8:00 AM to 5:00 PM' });
    assert.equal(typeof policy.data.policy.paymentHours.openNow, 'boolean');

    // A payment dated a Saturday or Sunday is refused.
    process.env.LOAN_PAYMENT_HOURS = 'Mon-Fri 00:00-24:00';
    for (const weekend of [lastDay(6), lastDay(7)]) {
      const refused = await pay(weekend);
      assert.equal(refused.status, 400, JSON.stringify(refused.data));
      assert.match(refused.data.message, /Loan payments are received Monday to Friday, any time only\. .* is a (Saturday|Sunday)\./);
    }

    // Outside office hours nothing can be recorded, whatever the payment date.
    const other = (isoDay(today) % 7) + 1;
    process.env.LOAN_PAYMENT_HOURS = `${DAYS[other - 1]} 00:00-24:00`;
    const closed = await pay(lastDay(other));
    assert.equal(closed.status, 400, JSON.stringify(closed.data));
    assert.match(closed.data.message, /only during office hours/);
    assert.equal((await member.get('/api/loans/policy')).data.policy.paymentHours.openNow, false);

    // New loans: every installment falls on a day the office receives payments.
    process.env.LOAN_PAYMENT_HOURS = 'Mon-Fri 08:00-17:00';
    const released = await applyWithIds(admin, '/api/admin/loans', {
      loanType: 'agricultural', loanMode: 'cash', cashAmount: '2400', term: 12, farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay', cropsPlanted: 'Palay', certified: true, memberId: state.memberId,
    }, { acknowledgeIdWarnings: true });
    assert.equal(released.status, 201, JSON.stringify(released.data));
    const loanId = released.data.loan.databaseId;
    const detail = await admin.get(`/api/admin/loans/${loanId}`);
    const dueDates = detail.data.installments.map((row) => row.dueDate);
    assert.equal(dueDates.length, 12);
    assert.ok(dueDates.every((date) => isoDay(date) <= 5), JSON.stringify(dueDates));
    assert.equal(detail.data.loan.dueDate, dueDates.at(-1), 'the loan is due with its last installment');
    await pool.query('DELETE FROM loans WHERE id = $1', [loanId]);
  } finally {
    process.env.LOAN_PAYMENT_HOURS = 'Mon-Sun 00:00-24:00';
  }
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
  const newId = Buffer.concat([PNG, Buffer.from([9])]);
  replaceForm.append('id_document_reading', String((await readMemberId(admin, idCopy, newId)).data.readingId));
  replaceForm.append('idDocument', new Blob([newId], { type: 'image/png' }), 'new-id.png');
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

  // What needs the admin's attention: counts the dashboard turns into links.
  for (const key of ['overdueLoans', 'loansDueThisWeek', 'pendingLoanRequests', 'pendingRentalRequests', 'scheduledOperations', 'lowStockItems']) {
    assert.ok(Number.isInteger(dashboard.data.stats[key]), key);
  }
  assert.equal(dashboard.data.alerts, undefined, 'the dashboard shows the counts, not alert sentences');
  // The member cards are on the dashboard, no longer in Analytics.
  assert.equal(analytics.data.shareCapitalLevels, undefined);
  assert.equal(analytics.data.summary.registeredMembers, undefined);

  // Members (terminated ones left out) by share capital, in bands up to the PHP 20,000 maximum.
  const levels = dashboard.data.shareCapitalLevels;
  assert.deepEqual(levels.map((level) => [level.key, level.min, level.max]), [['below1k', 0, 1000], ['from1kTo5k', 1000, 5000], ['from5kTo15k', 5000, 15000], ['from15kTo20k', 15000, 20000], ['maximum', 20000, null]]);
  const memberShares = (await pool.query(`SELECT COALESCE(SUM(sc.amount), 0) AS total FROM members m LEFT JOIN share_contributions sc ON sc.member_id = m.id WHERE m.status <> 'archived' GROUP BY m.id`)).rows.map((row) => Number(row.total));
  const bandOf = (total) => levels.findIndex((level) => total >= level.min && (level.max === null || total < level.max));
  assert.deepEqual(levels.map((level) => level.members), levels.map((_, index) => memberShares.filter((total) => bandOf(total) === index).length));
  assert.equal(levels.reduce((sum, level) => sum + level.members, 0), dashboard.data.stats.totalMembers);
  assert.ok(levels[1].members >= 1, 'Juan is in PHP 1,000 to 4,999');

  // Members (terminated ones left out) with and without a login account.
  const accounts = (await pool.query(`SELECT COUNT(u.id)::int AS registered, (COUNT(*) - COUNT(u.id))::int AS unregistered
    FROM members m LEFT JOIN users u ON u.member_id = m.id WHERE m.status <> 'archived'`)).rows[0];
  const { registeredMembers, unregisteredMembers } = dashboard.data.stats;
  assert.deepEqual([registeredMembers, unregisteredMembers], [accounts.registered, accounts.unregistered]);
  assert.ok(registeredMembers >= 1, 'Juan has an account');
  assert.equal(registeredMembers + unregisteredMembers, levels.reduce((sum, level) => sum + level.members, 0), 'the same members as the share capital chart');
  // A bar clicked: the members in that band, most share capital first.
  for (const level of levels) {
    const list = await admin.get(`/api/admin/dashboard/share-capital/${level.key}`);
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.members.length, level.members, level.key);
    assert.ok(list.data.members.every((row) => row.shareCapital >= level.min && (level.max === null || row.shareCapital < level.max) && row.status !== 'archived'), level.key);
    assert.deepEqual(list.data.members.map((row) => row.shareCapital), list.data.members.map((row) => row.shareCapital).sort((a, b) => b - a));
  }
  // The same share capital as on the member record.
  const juanShare = (await admin.get(`/api/members/${state.memberId}`)).data.data.shareDetails.total;
  const juanBand = (await admin.get('/api/admin/dashboard/share-capital/from1kTo5k')).data.members.find((row) => row.id === state.memberId);
  assert.deepEqual([juanBand.memberName, juanBand.shareCapital], ['Juan Dela Cruz', juanShare]);
  assert.equal((await admin.get('/api/admin/dashboard/share-capital/nonsense')).status, 404);
  assert.equal((await member.get('/api/admin/dashboard/share-capital/below1k')).status, 403);

  // Net income: Kadiwa net sales + machinery (rentals started, service fees collected,
  // other income, less expenses) + loan interest collected.
  const { netIncome, netIncomeBreakdown: parts } = dashboard.data.stats;
  assert.equal(dashboard.data.stats.kadiwaRevenue, undefined);
  assert.equal(dashboard.data.stats.machineryOperations, undefined);
  assert.equal(Math.round((parts.kadiwa + parts.machinery + parts.loans) * 100), Math.round(netIncome * 100));
  assert.equal(parts.kadiwa, analytics.data.summary.kadiwaNetSales);
  assert.equal(parts.loans, analytics.data.summary.interestCollected);
  assert.ok(parts.loans > 0, 'the loan payments in these tests include interest');
  const machinery = (await pool.query(`SELECT
      (SELECT COALESCE(SUM(rental_fee), 0) FROM machinery_operations mo WHERE start_date <= (NOW() AT TIME ZONE 'Asia/Manila')::date
        AND NOT EXISTS (SELECT 1 FROM machinery_services s WHERE s.rental_request_id = mo.rental_request_id))
    + (SELECT COALESCE(SUM(amount_paid), 0) FROM machinery_services)
    + (SELECT COALESCE(SUM(other_income), 0) FROM machinery_period_balances)
    - (SELECT COALESCE(SUM(amount), 0) FROM machinery_expenses) AS net`)).rows[0].net;
  assert.equal(parts.machinery, Number(machinery));
  // The card lists the statutory funds set aside from that net income.
  assert.deepEqual(dashboard.data.stats.statutoryFunds.map(({ key, percent, amount }) => [key, percent, amount]), [
    ['reserve', 10, Math.round(Math.max(0, netIncome) * 10) / 100],
    ['education', 10, Math.round(Math.max(0, netIncome) * 10) / 100],
    ['community', 3, Math.round(Math.max(0, netIncome) * 3) / 100],
    ['optional', 7, Math.round(Math.max(0, netIncome) * 7) / 100],
  ]);

  // A member's dividend: this year's net income, less 30% statutory funds, half
  // of the surplus shared by share capital.
  const cents = (amount) => Math.round(amount * 100);
  const dividend = await member.get('/api/members/me/dividend');
  assert.equal(dividend.status, 200, JSON.stringify(dividend.data));
  const d = dividend.data.data;
  assert.equal(d.year, Number(d.asOf.slice(0, 4)));
  assert.equal(d.yearComplete, false);
  assert.deepEqual(d.rates, { statutory: 30, dividendPool: 50, patronageRefundPool: 50 });
  assert.equal(cents(d.netIncomeParts.kadiwa + d.netIncomeParts.machinery + d.netIncomeParts.loans), cents(d.netIncome));
  assert.equal(cents(d.statutoryTotal + d.netSurplus), cents(Math.max(0, d.netIncome)));
  assert.equal(cents(d.dividendPool + d.patronageRefundPool), cents(d.netSurplus));
  const shares = (await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE member_id = $1), 0) AS member, COALESCE(SUM(amount), 0) AS total
     FROM share_contributions WHERE contribution_date <= $2 AND member_id IN (SELECT id FROM members WHERE status <> 'archived')`,
    [state.memberId, d.asOf]
  )).rows[0];
  assert.equal(d.memberShareCapital, Number(shares.member));
  assert.equal(d.totalShareCapital, Number(shares.total));
  assert.ok(d.memberShareCapital > 0 && d.shareRatio > 0 && d.shareRatio <= 1);
  assert.equal(d.dividend, Math.round(d.dividendPool * d.shareRatio * 100) / 100);
  const lastYear = await member.get(`/api/members/me/dividend?year=${d.year - 1}`);
  assert.equal(lastYear.status, 200);
  assert.equal(lastYear.data.data.asOf, `${d.year - 1}-12-31`);
  assert.equal(lastYear.data.data.yearComplete, true);
  for (const year of ['1999', String(d.year + 1), 'abc']) assert.equal((await member.get(`/api/members/me/dividend?year=${year}`)).status, 400, year);
  assert.equal((await admin.get('/api/members/me/dividend')).status, 403, 'only a member sees their own dividend');
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

test('attendance: activities, recording, duplicates, finalization, rates, cancellation and privacy', { skip }, async () => {
  const { hashPassword } = await import('../src/utils/password.js');
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const { canReceiveEvent } = await import('../src/services/events.js');
  const shift = (days) => new Date(Date.parse(`${todayDateOnly()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const [today, yesterday, lastWeek, nextWeek] = [todayDateOnly(), shift(-1), shift(-7), shift(7)];

  // Ana and Ben are active members, Carla is inactive, Dan joined today.
  const addMember = async (number, first, last, status, since) => (await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone, address, membership_date, share_capital, status)
     VALUES ($1, $2, $3, $4, '09170000000', 'Purok 3', $5, 0, $6) RETURNING id`,
    [number, first, last, `${first.toLowerCase()}.att@example.com`, since, status]
  )).rows[0].id;
  const ana = await addMember('ATT-001', 'Ana', 'Reyes', 'active', '2020-01-01');
  const ben = await addMember('ATT-002', 'Ben', 'Cruz', 'active', '2020-01-01');
  const carla = await addMember('ATT-003', 'Carla', 'Diaz', 'inactive', '2020-01-01');
  const dan = await addMember('ATT-004', 'Dan', 'Lim', 'active', today);
  await pool.query(`INSERT INTO users (member_id, username, email, password_hash, role, account_status) VALUES ($1, 'ana.att', NULL, $2, 'MEMBER', 'ACTIVE')`, [ana, await hashPassword('AnaPass1!')]);
  const office = new Client('10.0.10.1');
  const anaClient = new Client('10.0.10.2');
  assert.equal((await office.post('/api/auth/login', { usernameOrEmail: 'testadmin', password: 'AdminPass1!' })).status, 200);
  assert.equal((await anaClient.post('/api/auth/login', { usernameOrEmail: 'ana.att', password: 'AnaPass1!' })).status, 200);

  // Creating activities: required fields, the end after the start, nothing completed in the future.
  const meeting = { title: 'Monthly Meeting', category: 'meeting', activityDate: lastWeek, startTime: '08:00', endTime: '10:00', venue: 'ACIFAC Hall', organizer: 'Board of Directors' };
  const badTime = await office.post('/api/attendance/activities', { ...meeting, endTime: '07:30' });
  assert.deepEqual([badTime.status, badTime.data.message], [400, 'The end time must be later than the start time.']);
  assert.equal((await office.post('/api/attendance/activities', { ...meeting, title: '' })).status, 400);
  assert.equal((await office.post('/api/attendance/activities', { ...meeting, category: 'party' })).status, 400);
  assert.equal((await office.post('/api/attendance/activities', { ...meeting, activityDate: nextWeek, status: 'completed' })).status, 400);
  const created = await office.post('/api/attendance/activities', meeting);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const m1 = created.data.data.id;
  assert.deepEqual([created.data.data.status, created.data.data.final, created.data.data.categoryLabel], ['scheduled', false, 'Meeting']);
  const seminar = { ...meeting, title: 'Organic Farming Seminar', category: 'education_training', activityDate: nextWeek };
  const training = (await office.post('/api/attendance/activities', seminar)).data.data;

  // Recording: future activities wait for their day; only members on the activity date are listed.
  assert.equal((await office.request('PUT', `/api/attendance/activities/${training.id}/attendance`, { body: { records: [{ memberId: ana, status: 'present' }] } })).status, 400);
  const listed = await office.get(`/api/attendance/activities/${m1}/members?search=ATT-00`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.data.map((row) => row.memberNumber).sort(), ['ATT-001', 'ATT-002', 'ATT-003']);
  assert.equal((await office.get(`/api/attendance/activities/${m1}/members?search=ana%20reyes`)).data.data.length, 1);

  const save = (id, records, reason) => office.request('PUT', `/api/attendance/activities/${id}/attendance`, { body: { records, reason } });
  const first = await save(m1, [{ memberId: ana, status: 'present', checkInTime: '08:05', remarks: 'Brought the minutes' }, { memberId: ben, status: 'late', checkInTime: '08:40' }]);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([first.data.data.added, first.data.data.updated], [2, 0]);

  // No duplicates: saving again changes nothing, the database refuses a second row, a payload cannot list a member twice.
  const again = await save(m1, [{ memberId: ana, status: 'present', checkInTime: '08:05', remarks: 'Brought the minutes' }, { memberId: ben, status: 'late', checkInTime: '08:40' }]);
  assert.deepEqual([again.data.data.added, again.data.data.updated, again.data.data.unchanged], [0, 0, 2]);
  const rowsFor = async (id) => (await pool.query('SELECT member_id, attendance_status, source FROM activity_attendance WHERE activity_id = $1', [id])).rows;
  assert.equal((await rowsFor(m1)).length, 2);
  await assert.rejects(pool.query(`INSERT INTO activity_attendance (activity_id, member_id, attendance_status) VALUES ($1, $2, 'absent')`, [m1, ana]), (error) => error.code === '23505');
  assert.equal((await save(m1, [{ memberId: ana, status: 'present' }, { memberId: ana, status: 'late' }])).status, 400);
  const notMember = await save(m1, [{ memberId: dan, status: 'present' }]);
  assert.deepEqual([notMember.status, notMember.data.message], [400, 'Dan Lim was not a member on the activity date.']);

  // Before finalization nobody is counted absent and nothing counts in the rate.
  let mine = (await anaClient.get('/api/members/me/attendance')).data.data;
  assert.deepEqual([mine.summary.eligible, mine.summary.rate, mine.pending, mine.history[0].final], [0, null, 1, false]);
  assert.equal((await office.get('/api/attendance/reports/participation?member=ATT-00')).data.data.length, 0);
  const changed = await save(m1, [{ memberId: ben, status: 'excused', remarks: 'Sick' }]);
  assert.equal(changed.data.data.updated, 1);

  // Finalizing records every unmarked active member absent; inactive members and later members are left out.
  const expectedAbsent = Number((await pool.query(
    `SELECT COUNT(*) FROM members m WHERE m.status = 'active' AND m.membership_date <= $2::date
       AND NOT EXISTS (SELECT 1 FROM activity_attendance r WHERE r.activity_id = $1 AND r.member_id = m.id)`, [m1, lastWeek])).rows[0].count);
  const details = (await office.get(`/api/attendance/activities/${m1}`)).data.data;
  assert.deepEqual([details.toMarkAbsent, details.canFinalize, details.recordable], [expectedAbsent, true, true]);
  const finalized = await office.post(`/api/attendance/activities/${m1}/finalize`);
  assert.equal(finalized.status, 200, JSON.stringify(finalized.data));
  assert.equal(finalized.data.data.markedAbsent, expectedAbsent);
  assert.deepEqual([finalized.data.data.activity.status, finalized.data.data.activity.final], ['completed', true]);
  const m1Rows = await rowsFor(m1);
  assert.equal(m1Rows.find((row) => row.member_id === ana).attendance_status, 'present');
  assert.equal(m1Rows.find((row) => row.member_id === ben).attendance_status, 'excused');
  assert.ok(!m1Rows.some((row) => row.member_id === carla || row.member_id === dan));
  assert.ok(m1Rows.filter((row) => row.source === 'finalization').every((row) => row.attendance_status === 'absent'));
  assert.equal((await office.post(`/api/attendance/activities/${m1}/finalize`)).status, 409);

  // Corrections after finalizing need a reason and keep the old value in the audit log.
  const noReason = await save(m1, [{ memberId: ben, status: 'present' }]);
  assert.equal(noReason.status, 400);
  assert.equal((await save(m1, [{ memberId: ben, status: 'present', remarks: 'Signed the logbook late' }], 'Logbook checked')).status, 200);
  const corrected = (await pool.query(`SELECT old_values, new_values, details FROM audit_logs WHERE action = 'ATTENDANCE_CORRECTED' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.deepEqual([corrected.old_values.attendance_status, corrected.new_values.attendance_status, corrected.details.reason], ['excused', 'present', 'Logbook checked']);
  const history = (await office.get(`/api/attendance/activities/${m1}/history`)).data.data;
  assert.deepEqual(history.map((entry) => entry.action).slice(0, 2), ['ATTENDANCE_CORRECTED', 'ATTENDANCE_FINALIZED']);
  assert.deepEqual([history[0].from, history[0].to, history[0].reason], ['excused', 'present', 'Logbook checked']);
  assert.ok(history.some((entry) => entry.action === 'ATTENDANCE_UPDATED') && history.some((entry) => entry.action === 'ACTIVITY_CREATED'));
  // A finalized activity took place: it keeps its date and cannot be cancelled.
  assert.equal((await office.put(`/api/attendance/activities/${m1}`, { ...meeting, activityDate: shift(-8), status: 'completed' })).status, 400);
  assert.equal((await office.put(`/api/attendance/activities/${m1}`, { ...meeting, venue: 'Barangay Hall', status: 'completed' })).status, 200);
  assert.equal((await office.patch(`/api/attendance/activities/${m1}/cancel`, { reason: 'Mistake' })).status, 409);

  // A second meeting where Ana is excused, and a cancelled clean-up drive that never counts.
  const m2 = (await office.post('/api/attendance/activities', { ...meeting, title: 'Special Meeting', activityDate: yesterday })).data.data.id;
  assert.equal((await save(m2, [{ memberId: ana, status: 'excused', remarks: 'Out of town' }])).status, 200);
  assert.equal((await office.post(`/api/attendance/activities/${m2}/finalize`)).status, 200);
  const drive = (await office.post('/api/attendance/activities', { ...meeting, title: 'Canal Clean-up', category: 'community_development', activityDate: lastWeek })).data.data.id;
  assert.equal((await save(drive, [{ memberId: ana, status: 'present' }])).status, 200);
  assert.equal((await office.patch(`/api/attendance/activities/${drive}/cancel`, { reason: '' })).status, 400);
  const cancelled = await office.patch(`/api/attendance/activities/${drive}/cancel`, { reason: 'Heavy rain' });
  assert.deepEqual([cancelled.status, cancelled.data.data.status, cancelled.data.data.cancellationReason], [200, 'cancelled', 'Heavy rain']);
  assert.equal((await save(drive, [{ memberId: ben, status: 'present' }])).status, 409);
  assert.equal((await office.post(`/api/attendance/activities/${drive}/finalize`)).status, 409);

  // Ana: 2 eligible completed activities (the cancelled one is left out), 1 attended, 1 excused: 50%.
  mine = (await anaClient.get(`/api/members/me/attendance?memberId=${ben}`)).data.data;
  assert.equal(mine.member.id, ana, 'members only ever get their own records');
  assert.deepEqual([mine.summary.eligible, mine.summary.attended, mine.summary.present, mine.summary.excused, mine.summary.absent, mine.summary.rate], [2, 1, 1, 1, 0, 50]);
  assert.deepEqual(mine.byCategory.find((row) => row.category === 'meeting'), { category: 'meeting', label: 'Meeting', eligible: 2, attended: 1, present: 1, late: 0, absent: 0, excused: 1, rate: 50 });
  assert.equal(mine.byCategory.find((row) => row.category === 'community_development').rate, null, 'N/A without eligible activities');
  assert.equal(mine.mostRecent.title, 'Monthly Meeting');
  assert.deepEqual(mine.history.map((row) => row.title), ['Special Meeting', 'Monthly Meeting']);
  assert.deepEqual(mine.upcoming.map((row) => row.title), ['Organic Farming Seminar']);
  assert.equal(mine.history[0].recordedBy, undefined, 'members do not see who recorded it');
  assert.deepEqual((await office.get(`/api/attendance/members/${ana}`)).data.data.summary, mine.summary);
  assert.equal((await office.get(`/api/attendance/members/${dan}`)).data.data.summary.rate, null);

  // Reports: participation per member, history with filters, and the dashboard from the saved records.
  const report = (await office.get('/api/attendance/reports/participation?member=ATT-00')).data;
  assert.deepEqual(report.data.map((row) => [row.memberNumber, row.eligible, row.attended, row.excused, row.absent, row.rate]), [
    ['ATT-002', 2, 1, 0, 1, 50],
    ['ATT-001', 2, 1, 1, 0, 50],
  ]);
  assert.deepEqual((await office.get('/api/attendance/reports/participation?member=ATT-00&status=excused')).data.data.map((row) => row.memberNumber), ['ATT-001']);
  assert.deepEqual((await office.get(`/api/attendance/reports/participation?member=ATT-00&category=education_training`)).data.data, []);
  const records = (await office.get('/api/attendance/records?member=ATT-001')).data;
  assert.deepEqual(records.data.map((row) => [row.title, row.status]), [['Special Meeting', 'excused'], ['Monthly Meeting', 'present']]);
  assert.deepEqual([records.summary.present, records.summary.excused, records.summary.total], [1, 1, 2]);
  assert.equal((await office.get('/api/attendance/records?member=ATT-00&status=absent')).data.data.length, 1);

  const dashboard = (await office.get(`/api/attendance/dashboard?from=${shift(-30)}&to=${shift(30)}`)).data.data;
  const perActivity = (await pool.query(
    `SELECT 100.0 * COUNT(*) FILTER (WHERE attendance_status IN ('present', 'late')) / COUNT(*) AS rate FROM activity_attendance WHERE activity_id = ANY($1::int[]) GROUP BY activity_id`, [[m1, m2]])).rows;
  const entries = Number((await pool.query('SELECT COUNT(*) FROM activity_attendance WHERE activity_id = ANY($1::int[])', [[m1, m2]])).rows[0].count);
  assert.deepEqual(
    [dashboard.summary.scheduled, dashboard.summary.completed, dashboard.summary.cancelled, dashboard.summary.upcoming, dashboard.summary.attendanceEntries, dashboard.summary.membersParticipated, dashboard.summary.needsFinalizing],
    [1, 2, 1, 1, entries, 2, 0]
  );
  const meanRate = perActivity.reduce((sum, row) => sum + Number(row.rate), 0) / perActivity.length;
  assert.ok(Math.abs(dashboard.summary.averageRate - meanRate) <= 0.05, `average of each finalized activity's rate: ${dashboard.summary.averageRate} vs ${meanRate}`);
  assert.deepEqual(dashboard.upcoming.map((row) => row.title), ['Organic Farming Seminar']);
  const list = (await office.get('/api/attendance/activities?category=meeting&status=completed')).data;
  assert.deepEqual(list.data.map((row) => row.title), ['Special Meeting', 'Monthly Meeting']);
  assert.equal(list.data[1].venue, 'Barangay Hall');

  // Cancelling from the edit form needs a reason; a cancelled activity can be scheduled again.
  assert.equal((await office.put(`/api/attendance/activities/${training.id}`, { ...seminar, status: 'cancelled' })).status, 400);
  assert.equal((await office.put(`/api/attendance/activities/${training.id}`, { ...seminar, status: 'cancelled', cancellationReason: 'Speaker unavailable' })).data.data.status, 'cancelled');
  const restored = await office.put(`/api/attendance/activities/${training.id}`, { ...seminar, status: 'scheduled' });
  assert.deepEqual([restored.data.data.status, restored.data.data.cancelledAt], ['scheduled', null]);

  // Members cannot reach the office endpoints, another member's records, or change their own.
  for (const url of ['/api/attendance/dashboard', '/api/attendance/activities', `/api/attendance/activities/${m1}`, `/api/attendance/activities/${m1}/members`, '/api/attendance/records', '/api/attendance/reports/participation', `/api/attendance/members/${ben}`]) {
    assert.equal((await anaClient.get(url)).status, 403, url);
  }
  assert.equal((await anaClient.request('PUT', `/api/attendance/activities/${m1}/attendance`, { body: { records: [{ memberId: ana, status: 'present' }] } })).status, 403);
  assert.equal((await anaClient.post(`/api/attendance/activities/${m2}/finalize`)).status, 403);
  assert.equal((await anaClient.post('/api/attendance/activities', meeting)).status, 403);
  assert.equal((await new Client('10.0.10.3').get('/api/members/me/attendance')).status, 401);
  assert.equal((await office.get('/api/members/me/attendance')).status, 403, 'the office reads a member through /api/attendance/members/:id');
  // Live updates: a member hears about their own attendance rows only.
  const anaUser = { role: 'MEMBER', member_id: ana, user_id: 1 };
  assert.equal(canReceiveEvent(anaUser, { table: 'activity_attendance', memberId: ana }), true);
  assert.equal(canReceiveEvent(anaUser, { table: 'activity_attendance', memberId: ben }), false);
  assert.equal(canReceiveEvent(anaUser, { table: 'activities' }), true);
});
