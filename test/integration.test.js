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
// The second, cross-check reading of a form: null = the same answer as the first; secondMode 'fail' = AI busy for it.
let stubSecondReading = null;
let secondMode = 'ok';
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
  delete(url) { return this.request('DELETE', url); }
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
// A member has one open loan at a time: tests that lend to the same member again settle the open ones first.
const settleOpenLoans = (memberId) => pool.query(`UPDATE loans SET status = 'paid', balance = 0, next_payment_date = NULL WHERE member_id = $1 AND status <> 'paid'`, [memberId]);

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
    // A failing AI stub answers at once instead of after the 2 s and 5 s waits; the retry queue is tested instead.
    OCR_AI_RETRY_DELAYS_MS: '', OCR_SERVICE_AREA: '',
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
      const secondReading = prompt.startsWith('You are a careful data-entry clerk');
      if (secondReading && secondMode === 'fail') { res.writeHead(503); res.end('{}'); return; }
      const answer = secondReading && stubSecondReading ? stubSecondReading
        : prompt.startsWith('You check the valid ID that') ? stubIdReading : prompt.includes('2x2 ID picture that an applicant submits') ? stubPhotoReading
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
  // No username to choose: the member signs in with the email and mobile number in their information.
  const info = (await pool.query('SELECT member_number, email, phone FROM members WHERE id = $1', [state.memberId])).rows[0];
  const created = await admin.post('/api/admin/accounts', { memberId: state.memberId, username: 'ignored', password: 'TempPass1!', confirmPassword: 'TempPass1!' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual([created.data.username, created.data.warnings], [info.member_number.toLowerCase(), []]);
  state.memberUserId = created.data.user.id;
  assert.equal((await admin.post('/api/admin/accounts', { memberId: state.memberId, password: 'TempPass1!', confirmPassword: 'TempPass1!' })).status, 409, 'one account per member');
  const listed = (await admin.get('/api/admin/accounts')).data.accounts.find((row) => row.user_id === state.memberUserId);
  assert.deepEqual([listed.email, listed.phone], ['juan@example.com', info.phone]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const setupMail = sentEmails.find((mail) => mail.to === 'juan@example.com' && /account is ready/i.test(mail.subject));
  assert.ok(setupMail, 'setup email sent');
  assert.match(setupMail.text, /http:\/\/localhost:5173\/reset-password\?token=[a-f0-9]{64}/);
  assert.match(setupMail.text, /Sign in to ACIFAC with your email \(juan@example\.com\) or your mobile number \(0\d{3} ••• \d{4}\)/);

  // A member with neither an email nor a mobile number has nothing to sign in with.
  const bare = await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone, address, membership_date, share_capital, status, farm_area_ha, date_of_birth)
     VALUES ('ACIFAC-2026-899', 'Nilo', 'Bautista', NULL, '044 123 4567', 'Purok 3', '2026-01-15', 0, 'active', 1, '1980-01-01') RETURNING id`
  );
  const refused = await admin.post('/api/admin/accounts', { memberId: bare.rows[0].id, password: 'TempPass1!', confirmPassword: 'TempPass1!' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.message, /email or mobile number/);
  await pool.query('DELETE FROM members WHERE id = $1', [bare.rows[0].id]);

  const byNumber = await new Client('10.0.1.9').post('/api/auth/login', { usernameOrEmail: `+63 ${info.phone.replace(/\D/g, '').slice(-10)}`, password: 'TempPass1!' });
  assert.equal(byNumber.status, 200, 'the member information\'s mobile number, in any format');
  const login = await member.post('/api/auth/login', { usernameOrEmail: 'Juan@Example.com', password: 'TempPass1!' });
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
  const relogin = await member.post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'MemberPass1!' });
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
  // Every loan is for 6 months, repaid in one payment of the whole amount (a term sent is ignored).
  const quote = await member.post('/api/loans/quote', { farmArea: '2', amount: '50000', term: 12 });
  assert.deepEqual([quote.data.quote.maximumEligibleAmount, quote.data.quote.calculatedInterest, quote.data.quote.totalRepayment, quote.data.quote.monthlyPayment, quote.data.quote.term],
    ['100000.00', '1250.00', '51250.00', '51250.00', 6]);

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
  assert.equal(detail.data.loan.term, 6);
  assert.equal(detail.data.loan.repayment, 'single');
  // One installment of the whole amount, due 6 months after approval (moved to an office day).
  assert.equal(detail.data.installments.length, 1);
  assert.equal(detail.data.installments[0].amountDue, '51250.00');
  const dueDays = (Date.parse(detail.data.installments[0].dueDate) - Date.parse(detail.data.loan.dateApproved)) / 86400000;
  assert.ok(dueDays >= 181 && dueDays <= 186, String(dueDays));
  assert.match(detail.data.loan.id, /^L-\d{4}-\d{3}$/);

  const future = await admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: '100', paymentDate: '2999-01-01' });
  assert.equal(future.status, 400);
  const over = await admin.post(`/api/admin/loans/${state.loanId}/payments`, { amount: '60000', paymentDate: detail.data.loan.dateApproved });
  assert.equal(over.status, 400);
  // Two days before a 6-month loan is due, the member is reminded once: a notification, an email and a text.
  const { refreshLoanStatuses } = await import('../src/services/loanService.js');
  const { SQL_TODAY } = await import('../src/config/env.js');
  const dueDate = (await pool.query(`SELECT due_date FROM loan_installments WHERE loan_id = $1`, [state.loanId])).rows[0].due_date;
  const dueNotes = async () => (await pool.query(`SELECT message FROM notifications WHERE type = 'payment_due' AND user_id = $1`, [state.memberUserId])).rows;
  await pool.query(`UPDATE loan_installments SET due_date = ${SQL_TODAY} + 5 WHERE loan_id = $1`, [state.loanId]);
  await refreshLoanStatuses({ force: true });
  assert.deepEqual(await dueNotes(), [], 'no reminder 5 days before');
  await pool.query(`UPDATE loan_installments SET due_date = ${SQL_TODAY} + 2 WHERE loan_id = $1`, [state.loanId]);
  await refreshLoanStatuses({ force: true });
  await refreshLoanStatuses({ force: true });
  const due = await dueNotes();
  assert.equal(due.length, 1, 'one reminder, not repeated');
  assert.match(due[0].message, /^Your loan L-\d{4}-\d{3} \(PHP 51,250\.00\) is due on /);
  const { flushSmsOutbox: flushDue } = await import('../src/services/smsService.js');
  await flushDue();
  const dueTexts = sentTexts.filter((text) => text.message.startsWith('Your loan ') && text.message.includes('Please pay at the ACIFAC office.'));
  assert.equal(dueTexts.length, 1, 'texted once');
  assert.ok(dueTexts[0].message.length <= 160, dueTexts[0].message);
  await pool.query(`UPDATE loan_installments SET due_date = $2 WHERE loan_id = $1`, [state.loanId, dueDate]);
  await refreshLoanStatuses({ force: true });

  // Simulate time passing: move the loan 200 days into the past, past its due date.
  await pool.query(`UPDATE loans SET date_approved = date_approved - 200 WHERE id = $1`, [state.loanId]);
  await pool.query(`UPDATE loan_installments SET due_date = due_date - 200 WHERE loan_id = $1`, [state.loanId]);
  await refreshLoanStatuses({ force: true });
  await refreshLoanStatuses({ force: true });
  const overdue = await admin.get(`/api/admin/loans/${state.loanId}`);
  assert.equal(overdue.data.loan.status, 'overdue');
  assert.equal(overdue.data.loan.overdueAmount, '51250.00');
  assert.equal(overdue.data.loan.overdueInstallments, 1);
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
  assert.equal(rest.data.payment.interestPaid, '1250.00');
  assert.equal(rest.data.payment.principalPaid, '50000.00');
  assert.equal(rest.data.payment.remainingBalance, '0.00');
  const paid = await admin.get(`/api/admin/loans/${state.loanId}`);
  assert.equal(paid.data.loan.status, 'paid');
  assert.equal(paid.data.loan.balance, '0.00');
  assert.equal(paid.data.loan.totalPaid, '51250.00');
  assert.equal(paid.data.loan.nextPaymentDate, null);

  const mine = await member.get('/api/members/me');
  assert.equal(mine.data.data.loans[0].status, 'paid');
  assert.equal(mine.data.data.payments.length, 1);

  // Agricultural loans only.
  for (const loanType of ['emergency', 'personal']) {
    const other = await applyWithIds(member, '/api/members/me/loan-requests', { loanType, amount: '1000', term: 3, purpose: 'Repair', farmArea: '2' });
    assert.equal(other.status, 400, loanType);
    assert.match(other.data.message, /agricultural loans only/);
  }
  const declined = await applyWithIds(member, '/api/members/me/loan-requests', { amount: '1000', term: 3, purpose: 'Repair', farmArea: '2' });
  assert.equal(declined.data.request.loanType, 'agricultural', 'the loan type is agricultural when none is sent');
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
  const pump = (await admin.get('/api/machinery')).data.machinery.find((row) => row.id === 'RT-02');
  const base = { machineryId: pump.id, clientCategory: 'non_member', startDate: plus(20), endDate: plus(22), purpose: 'Land preparation' };

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
  // sql/050: ACIFAC's fleet is two rotavators with tractor and two Kubota harvesters,
  // each with its own ID, all paid per service, with the rates the office had set.
  const fleet = (await admin.get('/api/machinery')).data.machinery;
  const tractor = fleet.find((row) => row.id === 'RT-01');
  const harvester = fleet.find((row) => row.id === 'HK-01');
  const seeded = fleet.filter((row) => /^(RT|HK)-/.test(row.id)).map((row) => [row.id, row.name, row.type, row.pricingMode]);
  assert.deepEqual(seeded, [
    ['HK-01', 'Harvester Kubota 1', 'Harvester Kubota', 'per_service'], ['HK-02', 'Harvester Kubota 2', 'Harvester Kubota', 'per_service'],
    ['RT-01', 'Rotavator w/ Tractor 1', 'Rotavator w/ Tractor', 'per_service'], ['RT-02', 'Rotavator w/ Tractor 2', 'Rotavator w/ Tractor', 'per_service'],
  ]);
  assert.ok(!fleet.some((row) => /^M-00[1-8]$/.test(row.id) && ['Water Pump', 'Rice Thresher', 'Hand Tractor'].includes(row.name)), 'the earlier machines are gone');
  for (const id of ['RT-01', 'RT-02']) {
    const rates = (await admin.get(`/api/machinery/${id}/rates`)).data.rates;
    assert.deepEqual(rates.map((rate) => [rate.serviceType, rate.unit, rate.memberRate, rate.nonMemberRate, rate.effectiveFrom, rate.effectiveTo]).sort(), [
      ['Rotavator', 'per_ha', '2800.00', '2800.00', '2026-01-01', '2026-04-30'], ['Rotavator', 'per_ha', '3800.00', '4000.00', '2026-05-01', null],
      ['Squadrone', 'per_ha', '3400.00', '3400.00', '2026-05-01', null], ['Squadrone', 'per_ha', '3500.00', '3500.00', '2026-04-01', '2026-04-30'],
      ['Tudling', 'per_ha', '1800.00', '1800.00', '2026-01-01', null],
    ], `${id} keeps the tractor's rates`);
  }
  for (const id of ['HK-01', 'HK-02']) {
    const rates = (await admin.get(`/api/machinery/${id}/rates`)).data.rates;
    assert.deepEqual(rates.map((rate) => [rate.serviceType, rate.unit, rate.memberRate, rate.nonMemberRate, rate.effectiveFrom, rate.effectiveTo]),
      [['Harvesting', 'per_100_bags', '10.00', '12.00', '2020-12-08', null]], `${id} keeps the harvester's rates`);
  }

  // Members book any machine of the fleet; its fee is charged when the work is recorded here.
  const catalog = (await member.get('/api/machinery/catalog')).data.machinery;
  assert.deepEqual(catalog.filter((row) => /^(RT|HK)-/.test(row.id)).map((row) => row.id), ['HK-01', 'HK-02', 'RT-01', 'RT-02']);
  const booking = await member.post('/api/machinery/requests', { machineryId: tractor.id, startDate: '2099-01-01', endDate: '2099-01-03', purpose: 'Land preparation' });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  assert.deepEqual([booking.data.request.duration, Number(booking.data.request.rentalFee)], [2, 0]);
  assert.equal((await admin.patch(`/api/machinery/requests/${booking.data.request.id}`, { status: 'declined' })).status, 200);
  assert.equal((await member.get('/api/machinery/day-rentals')).status, 404, 'Day Rentals are gone');
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
  await admin.post('/api/machinery/expenses', { machineryId: tractor.id, expenseDate: '2026-06-05', croppingPeriod: '1st', year: 2026, category: 'repair_maintenance', amount: '3000', description: 'Rotavator blades' });
  const late = await admin.post('/api/machinery/expenses', { machineryId: tractor.id, expenseDate: '2026-08-15', croppingPeriod: '1st', year: 2026, category: 'labor', amount: '1500' });
  const expenses = await admin.get(`/api/machinery/expenses?croppingPeriod=1st&year=2026`);
  assert.equal(expenses.data.totals.total, '7000.00');
  assert.equal((await admin.put('/api/machinery/period-balances', { machineryId: tractor.id, croppingPeriod: '1st', year: 2026, beginningCash: '10000', otherIncome: '500' })).status, 200);

  const report = await admin.get(`/api/machinery/reports/philmech?croppingPeriod=1st&year=2026&fromMonth=1&toMonth=7`);
  assert.equal(report.status, 200, JSON.stringify(report.data));
  const tractorReport = report.data.report.machines.find((row) => row.machineryId === tractor.id);
  assert.deepEqual(tractorReport.implements, [], 'the rotavator is part of the machine');
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
  const expenseChanges = (await pool.query(`SELECT action, new_values ->> 'capital_change' AS change FROM audit_logs WHERE entity_type = 'machinery_expense' AND entity_id = $1 ORDER BY id`, [String(late.data.expense.id)])).rows;
  assert.deepEqual(expenseChanges.map((row) => [row.action, row.change]), [['MACHINERY_EXPENSE_RECORDED', '-1500.00'], ['MACHINERY_EXPENSE_DELETED', '+1500.00']], 'an expense takes from the capital; deleting it puts the money back');
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

test('machinery: the booking calendar shows which machine is free each day; a booking is recorded as a service', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const today = todayDateOnly();
  const plus = (days) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  // The office books RT-02 for a non-member; a member asks for HK-02 (still pending).
  const office = await admin.post('/api/machinery/requests', { machineryId: 'RT-02', clientCategory: 'non_member', clientName: 'Mario Reyes', startDate: plus(70), endDate: plus(72), purpose: 'Land preparation' });
  assert.equal(office.status, 201, JSON.stringify(office.data));
  assert.equal((await admin.patch(`/api/machinery/requests/${office.data.request.id}`, { status: 'approved' })).status, 200);
  const asked = await member.post('/api/machinery/requests', { machineryId: 'HK-02', startDate: plus(71), endDate: plus(71), purpose: 'Harvesting' });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal((await member.post('/api/machinery/requests', { machineryId: 'RT-02', startDate: plus(72), endDate: plus(74), purpose: 'x' })).status, 409, 'booked days are taken');

  const url = `/api/machinery/availability?from=${plus(69)}&to=${plus(73)}`;
  const seen = (await member.get(url)).data;
  assert.deepEqual(seen.machinery.filter((row) => /^(RT|HK)-/.test(row.id)).map((row) => row.id), ['HK-01', 'HK-02', 'RT-01', 'RT-02']);
  const mine = seen.bookings.filter((row) => ['RT-02', 'HK-02'].includes(row.machineryId));
  assert.deepEqual(mine.map((row) => [row.status, row.machineryId, row.startDate, row.endDate]), [['booked', 'RT-02', plus(70), plus(72)], ['pending', 'HK-02', plus(71), plus(71)]]);
  assert.ok(seen.bookings.every((row) => !('renter' in row) && !('purpose' in row)), 'members do not see who booked');
  const forOffice = (await admin.get(url)).data.bookings.find((row) => row.machineryId === 'RT-02');
  assert.deepEqual([forOffice.renter, forOffice.purpose, forOffice.requestId], ['Mario Reyes', 'Land preparation', office.data.request.id]);
  // Days outside the range are left out.
  assert.ok(!(await member.get(`/api/machinery/availability?from=${plus(80)}&to=${plus(85)}`)).data.bookings.some((row) => row.machineryId === 'RT-02' && row.startDate === plus(70)));
  for (const bad of [`from=${plus(5)}&to=${plus(4)}`, `from=${plus(1)}&to=${plus(100)}`, 'from=soon&to=later', '']) {
    assert.equal((await member.get(`/api/machinery/availability?${bad}`)).status, 400, bad);
  }

  // The work done on a booking is recorded as a service of that machine, at its rate.
  const service = await admin.post('/api/machinery/services', {
    machineryId: 'RT-02', croppingPeriod: '1st', year: 2026, serviceType: 'Rotavator', serviceDate: '2026-06-10', clientCategory: 'non_member', clientName: 'Mario Reyes', areaHa: '1',
    rentalRequestId: office.data.request.id,
  });
  assert.equal(service.status, 201, JSON.stringify(service.data));
  assert.equal(service.data.service.feeAmount, '4000.00', 'the non-member rotavator rate per hectare');
  const wrong = await admin.post('/api/machinery/services', { machineryId: 'HK-01', croppingPeriod: '1st', year: 2026, serviceType: 'Harvesting', serviceDate: '2026-05-05', clientCategory: 'non_member', clientName: 'Mario Reyes', totalBags: '100', bagValue: '1000', rentalRequestId: office.data.request.id });
  assert.equal(wrong.status, 400, 'a booking belongs to its own machine');
  assert.equal((await admin.request('DELETE', `/api/machinery/services/${service.data.service.id}`)).status, 200);
  assert.equal((await admin.patch(`/api/machinery/requests/${asked.data.request.id}`, { status: 'declined' })).status, 200);

  // The office is told on the day an approved booking starts, once per admin, member or non-member.
  const { refreshRentalStatuses } = await import('../src/controllers/machineryController.js');
  const dueToday = await admin.post('/api/machinery/requests', { machineryId: 'RT-01', clientCategory: 'non_member', clientName: 'Lito Manalo', startDate: today, endDate: plus(1), purpose: 'Land preparation' });
  assert.equal(dueToday.status, 201, JSON.stringify(dueToday.data));
  assert.equal((await admin.patch(`/api/machinery/requests/${dueToday.data.request.id}`, { status: 'approved' })).status, 200);
  await refreshRentalStatuses();
  await refreshRentalStatuses();
  const operations = (await admin.get('/api/machinery?limit=200')).data.operations;
  const todayOp = operations.find((row) => row.rentalRequestId === dueToday.data.request.id);
  const laterOp = operations.find((row) => row.rentalRequestId === office.data.request.id);
  const admins = (await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE'`)).rows[0].count;
  const told = (await pool.query(`SELECT title, message FROM notifications WHERE type = 'booking_due' AND dedupe_key = $1`, [`booking-due-${todayOp.id}`])).rows;
  assert.equal(told.length, admins, 'each admin once, however often the statuses are refreshed');
  assert.match(told[0].message, /^Rotavator w\/ Tractor 1: Lito Manalo \(non-member\), .* to .*\. Purpose: Land preparation\.$/);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE dedupe_key = $1`, [`booking-due-${laterOp.id}`])).rows[0].count, 0, 'not before its day');
  assert.equal((await admin.request('PATCH', `/api/machinery/operations/${todayOp.id}`, { body: { status: 'completed' } })).status, 200);
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
  // Alone or with other little-used machines (one recommendation either way).
  assert.ok(data.ruleRecommendations.some((item) => item.type === 'promote' && /Analytics Tractor \(3%\)|Find more work for Analytics Tractor[\s\S]*Only 3%/.test(`${item.title} ${item.reason}`)), JSON.stringify(data.ruleRecommendations));
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

  // Overall: every completed sale, from the first one to today, however long ago.
  const overall = (await admin.get(`${'/api/kadiwa/sales'}?overall=true`)).data;
  const counted = (await pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(net_sales), 0) AS net, TO_CHAR(MIN(sale_date), 'YYYY-MM-DD') AS first FROM kadiwa_sales WHERE status = 'completed' AND sale_date <= (NOW() AT TIME ZONE 'Asia/Manila')::date`)).rows[0];
  assert.deepEqual([overall.from, overall.sales.length, overall.report.totals.sales], [counted.first, counted.count, counted.count]);
  assert.equal(Math.round(Number(overall.report.totals.net) * 100), Math.round(Number(counted.net) * 100), 'the same net income as the Net Income card counts');
  assert.ok(overall.sales.some((entry) => entry.id === sale.data.sale.id));
  assert.equal((await admin.get('/api/kadiwa/sales?from=2020-01-01&to=2026-01-01')).status, 400, 'a chosen period is still at most a year');

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

test('kadiwa analytics: best sellers and items running out', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const today = todayDateOnly();
  const daysAgo = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const product = (name, stock, extra = {}) => ({ name, unit: 'pc', stock: String(stock), price: '20', costPrice: '15', reorderLevel: '2', ...extra });
  const added = await admin.post('/api/kadiwa/inventory', { items: [product('Zz Fast Soap', 10), product('Zz Slow Vinegar', 20)] });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const id = (name) => added.data.items.find((item) => item.name === name).id;
  const sell = (saleDate, items, goods = []) => admin.post('/api/kadiwa/sales', { sellerName: 'Tester', saleDate, items, goods, expenses: [{ description: 'None', amount: '0' }] });
  assert.equal((await sell(daysAgo(8), [{ inventoryId: id('Zz Fast Soap'), quantity: '3' }])).status, 201);
  assert.equal((await sell(daysAgo(4), [{ inventoryId: id('Zz Fast Soap'), quantity: '3' }, { inventoryId: id('Zz Slow Vinegar'), quantity: '1' }], [{ name: 'Zz Lechon', unit: 'kilo', amount: '95000' }])).status, 201);

  // Ten days, today included: soap sold 6 (0.6 a day) and has 4 left, about 6 days.
  const url = `/api/admin/analytics/kadiwa-products?from=${daysAgo(9)}&to=${today}`;
  assert.equal((await member.get(url)).status, 403);
  const data = (await admin.get(url)).data;
  assert.equal(data.period.days, 10);
  assert.deepEqual([data.bestSellers[0].name, data.bestSellers[0].kind, data.bestSellers[0].amount], ['ZZ LECHON', 'goods', 95000], 'goods and store items ranked together by sales');
  const soap = data.runningOut.find((item) => item.name === 'Zz Fast Soap');
  assert.deepEqual([soap?.quantity, soap?.stock, soap?.perDay, soap?.daysLeft], [6, 4, 0.6, 6]);
  assert.ok(!data.runningOut.some((item) => item.name === 'Zz Slow Vinegar'), 'vinegar has 190 days left at its pace');
  assert.ok(data.summary.totalSales >= 95000 + 6 * 20 + 20);
  assert.equal(data.noSales, undefined, 'items not selling are not listed');
  // A period still to come has nothing to judge.
  const ahead = (await admin.get(`/api/admin/analytics/kadiwa-products?from=2999-01-01&to=2999-01-31`)).data;
  assert.deepEqual([ahead.period.days, ahead.bestSellers.length, ahead.runningOut.length], [0, 0, 0]);
  assert.equal((await admin.post('/api/admin/analytics/kadiwa-products/advice', { from: daysAgo(9), to: today })).status, 404, 'no suggestions endpoint');
});

test('kadiwa: member purchases on a sale earn patronage points', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const member = (await pool.query(`SELECT id, member_number, first_name, last_name FROM members WHERE id = $1`, [state.memberId])).rows[0];
  const second = (await pool.query(`SELECT id FROM members WHERE id = $1`, [state.secondMemberId])).rows[0];

  // Members are found by member ID or name.
  const byNumber = await admin.get(`/api/kadiwa/members?search=${encodeURIComponent(member.member_number)}`);
  assert.equal(byNumber.status, 200);
  assert.equal(byNumber.data.members[0].id, member.id);
  const byName = await admin.get(`/api/kadiwa/members?search=${encodeURIComponent(member.last_name)}`);
  assert.ok(byName.data.members.some((row) => row.id === member.id));
  assert.deepEqual((await admin.get('/api/kadiwa/members?search=a')).data.members, []);

  const sale = {
    saleDate: todayDateOnly(), goods: [{ name: 'TALONG', unit: 'KILO', price: '100', amount: '1000' }], items: [], expenses: [{ description: 'None', amount: '0' }],
  };
  const url = '/api/kadiwa/sales';
  // Together never more than the day's sales; each member once; amounts more than zero; only active members.
  assert.match((await admin.post(url, { ...sale, memberPurchases: [{ memberId: member.id, amount: '1200' }] })).data.message, /more than the day's total sales/);
  assert.match((await admin.post(url, { ...sale, memberPurchases: [{ memberId: member.id, amount: '100' }, { memberId: member.id, amount: '50' }] })).data.message, /already listed/);
  assert.equal((await admin.post(url, { ...sale, memberPurchases: [{ memberId: member.id, amount: '0' }] })).status, 400);
  assert.equal((await admin.post(url, { ...sale, memberPurchases: [{ memberId: 999999, amount: '10' }] })).status, 400);

  const saved = await admin.post(url, { ...sale, memberPurchases: [{ memberId: member.id, amount: '650' }, { memberId: second.id, amount: '125.50' }] });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.sale.memberPurchases.map((line) => [line.memberId, Number(line.amount), Number(line.points)]), [[member.id, 650, 6.5], [second.id, 125.5, 1.26]]);
  // On the sale's record in the audit log too.
  const audit = (await admin.get('/api/admin/audit-logs?action=KADIWA_SALE_CREATED')).data.data[0];
  assert.equal(audit.new_values.member_purchases[0].member_number, member.member_number);
  // Listed with the sales.
  const listed = (await admin.get('/api/kadiwa')).data.sales.find((row) => row.id === saved.data.sale.id);
  assert.equal(listed.memberPurchases.length, 2);
});

test('kadiwa vendors: an administrator makes the account; the vendor\'s sales count only once an administrator confirms them', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const today = todayDateOnly();
  const vendor = new Client();

  // The account: a name, a username and a password the administrator gives.
  const account = { fullName: 'Rosa Vendor', username: 'rosa.vendor', password: 'Vendor123!', confirmPassword: 'Vendor123!' };
  assert.equal((await admin.post('/api/admin/accounts/vendors', { ...account, confirmPassword: 'Other123!' })).status, 400);
  assert.equal((await admin.post('/api/admin/accounts/vendors', { ...account, fullName: '' })).status, 400);
  assert.equal((await admin.post('/api/admin/accounts/vendors', { ...account, password: 'short', confirmPassword: 'short' })).status, 400);
  assert.equal((await member.post('/api/admin/accounts/vendors', account)).status, 403);
  const created = await admin.post('/api/admin/accounts/vendors', account);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.role, 'VENDOR');
  assert.equal(created.data.user.password_hash, undefined);
  assert.equal((await admin.post('/api/admin/accounts/vendors', account)).status, 409, 'username taken');
  const vendorId = created.data.user.id;
  const listed = (await admin.get('/api/admin/accounts')).data.accounts.find((row) => row.user_id === vendorId);
  assert.equal(listed.role, 'VENDOR');
  assert.equal(listed.full_name, 'Rosa Vendor');

  // The vendor signs in on the same login with the username, and sees only the vendor pages.
  const login = await vendor.post('/api/auth/login', { usernameOrEmail: 'rosa.vendor', password: 'Vendor123!' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.role, 'VENDOR');
  assert.equal(login.data.mustChangePassword, false);
  // A vendor stays signed in at the store until they log out: no inactivity timeout, a long session.
  const vendorSession = (await pool.query(`SELECT id, expires_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [created.data.user.id])).rows[0];
  assert.ok(new Date(vendorSession.expires_at) - Date.now() > 300 * 24 * 3600 * 1000);
  await pool.query(`UPDATE sessions SET last_activity_at = NOW() - INTERVAL '3 hours' WHERE id = $1`, [vendorSession.id]);
  assert.equal((await vendor.get('/api/vendor/kadiwa')).status, 200, 'still signed in after hours without activity');
  for (const url of ['/api/kadiwa', '/api/admin/accounts', '/api/members', '/api/members/me']) assert.equal((await vendor.get(url)).status, 403, url);
  assert.equal((await vendor.post('/api/kadiwa/sales', { goods: [] })).status, 403);
  assert.equal((await admin.get('/api/vendor/kadiwa')).status, 403, 'the vendor pages are for vendors');
  const page = await vendor.get('/api/vendor/kadiwa');
  assert.equal(page.status, 200);
  assert.ok(page.data.goods.some((good) => good.name === 'TALONG'));
  assert.deepEqual(page.data.sales, []);
  // Every store item in the inventory, with its selling and cost price.
  const rice = page.data.inventory.find((item) => item.id === 'INV-001');
  assert.ok(rice && rice.costPrice !== null);
  assert.equal(page.data.inventory.length, (await admin.get('/api/kadiwa')).data.inventory.length);
  const stockOf = async () => Number((await pool.query(`SELECT stock FROM kadiwa_inventory WHERE id = 'INV-001'`)).rows[0].stock);
  const startStock = await stockOf();
  // The name stays the one the administrator gave.
  await vendor.patch('/api/auth/profile', { name: 'Someone Else' });
  assert.equal((await vendor.get('/api/auth/me')).data.user.full_name, 'Rosa Vendor');

  // A sale: the goods sold and the expenses, sent for review under the vendor's name.
  const sale = { saleDate: today, goods: [{ name: 'TALONG', unit: 'KILO', price: '80', amount: '400' }], expenses: [{ description: 'Ice', amount: '30' }] };
  // Expenses are not required on a vendor's sale: none typed means none.
  assert.match((await vendor.post('/api/vendor/kadiwa/sales', { ...sale, goods: [], expenses: [] })).data.message, /goods sold, a store item, or an expense/);
  // Expenses alone can be sent: the day's costs, with nothing sold.
  const expensesOnly = await vendor.post('/api/vendor/kadiwa/sales', { ...sale, goods: [] });
  assert.equal(expensesOnly.status, 201, JSON.stringify(expensesOnly.data));
  assert.deepEqual([Number(expensesOnly.data.sale.totalExpenses), Number(expensesOnly.data.sale.netSales)], [30, -30]);
  await admin.post(`/api/kadiwa/sales/${expensesOnly.data.sale.id}/review`, { decision: 'reject', notes: 'Test' });
  const before = (await admin.get('/api/kadiwa')).data.summary;
  assert.equal((await vendor.post('/api/vendor/kadiwa/sales', { ...sale, items: [{ inventoryId: 'INV-001', quantity: String(startStock + 1) }] })).status, 409, 'no overselling');
  // Store items: taken from the stock as the sale is sent, counted under GROCERIES; net income less their cost price.
  const sent = await vendor.post('/api/vendor/kadiwa/sales', { ...sale, sellerName: 'Not Me', items: [{ inventoryId: 'INV-001', quantity: '2' }], memberPurchases: [{ memberId: state.memberId, amount: '100' }] });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.sale.status, 'pending');
  assert.equal(sent.data.sale.seller, 'Rosa Vendor');
  assert.equal(sent.data.sale.byVendor, true);
  assert.equal(sent.data.sale.items.length, 1);
  assert.equal(Number(sent.data.sale.groceries), 2 * Number(rice.price));
  assert.equal(Number(sent.data.sale.costOfGoods), 2 * Number(rice.costPrice));
  // The members who bought (optional): found with the same member search, and their points count once the sale is confirmed.
  const found = await vendor.get(`/api/kadiwa/members?search=${encodeURIComponent(sent.data.sale.memberPurchases[0].memberNumber)}`);
  assert.equal(found.status, 200);
  assert.equal(found.data.members[0].id, state.memberId);
  assert.equal((await member.get('/api/kadiwa/members?search=ju')).status, 403);
  assert.deepEqual(sent.data.sale.memberPurchases.map((line) => [line.memberId, Number(line.amount)]), [[state.memberId, 100]]);
  assert.equal(Math.round(Number(sent.data.sale.netSales) * 100), Math.round((400 + 2 * Number(rice.price) - 30 - 2 * Number(rice.costPrice)) * 100));
  assert.equal(await stockOf(), startStock - 2);
  const saleId = sent.data.sale.id;

  // Waiting for review: listed for the administrators, counted nowhere.
  const kadiwa = (await admin.get('/api/kadiwa')).data;
  assert.equal(kadiwa.pendingSales.find((row) => row.id === saleId).seller, 'Rosa Vendor');
  assert.ok(!kadiwa.sales.some((row) => row.id === saleId));
  assert.equal(Number(kadiwa.summary.todaySales), Number(before.todaySales));
  assert.equal(Number(kadiwa.summary.totalNetSales), Number(before.totalNetSales));
  assert.ok(!(await admin.get(`/api/kadiwa/sales?from=${today}&to=${today}`)).data.sales.some((row) => row.id === saleId));
  const submitted = (await admin.get(`/api/admin/audit-logs?action=KADIWA_SALE_SUBMITTED`)).data.data.find((row) => row.entity_id === saleId);
  assert.equal(submitted.user_role_snapshot, 'VENDOR');
  assert.equal(submitted.new_values.capital_change, undefined);
  const notified = await pool.query(`SELECT 1 FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.role = 'ADMIN' AND n.type = 'kadiwa_sale_submitted' AND n.entity_id = $1`, [saleId]);
  assert.ok(notified.rowCount > 0);

  // Rejected with the reason; it can be reviewed once only.
  assert.equal((await vendor.post(`/api/kadiwa/sales/${saleId}/review`, { decision: 'confirm' })).status, 403, 'a vendor cannot confirm');
  assert.match((await admin.post(`/api/kadiwa/sales/${saleId}/review`, { decision: 'reject' })).data.message, /reason/);
  const rejected = await admin.post(`/api/kadiwa/sales/${saleId}/review`, { decision: 'reject', notes: 'TALONG was 300, not 400.' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.sale.status, 'rejected');
  assert.equal(rejected.data.sale.reviewNotes, 'TALONG was 300, not 400.');
  assert.equal(await stockOf(), startStock, 'a rejected sale puts its store items back');
  const rejectAudit = (await admin.get('/api/admin/audit-logs?action=KADIWA_SALE_REJECTED')).data.data[0];
  assert.equal(Number(rejectAudit.new_values.stock_returned[0].quantity), 2);
  assert.equal((await admin.post(`/api/kadiwa/sales/${saleId}/review`, { decision: 'confirm' })).status, 409);
  assert.equal((await admin.post('/api/kadiwa/sales/S-0000-99999/review', { decision: 'confirm' })).status, 404);
  assert.ok(!(await admin.get('/api/kadiwa')).data.pendingSales.some((row) => row.id === saleId));
  const mine = (await vendor.get('/api/vendor/kadiwa')).data.sales;
  assert.equal(mine.find((row) => row.id === saleId).status, 'rejected');

  // Sent again, corrected, and confirmed: now it counts, and the audit log names the administrator who confirmed it.
  const again = await vendor.post('/api/vendor/kadiwa/sales', { ...sale, goods: [{ name: 'TALONG', unit: 'KILO', price: '80', amount: '300' }] });
  assert.equal(again.status, 201);
  // A sale without expenses.
  const storeOnly = await vendor.post('/api/vendor/kadiwa/sales', { saleDate: today, goods: [{ name: 'TALONG', unit: 'KILO', price: '80', amount: '80' }], items: [{ inventoryId: 'INV-001', quantity: '1' }], expenses: [] });
  assert.equal(storeOnly.status, 201, JSON.stringify(storeOnly.data));
  assert.equal(Number(storeOnly.data.sale.totalExpenses), 0, 'no expenses typed');
  assert.equal(await stockOf(), startStock - 1);
  const confirmed = await admin.post(`/api/kadiwa/sales/${again.data.sale.id}/review`, { decision: 'confirm' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.sale.status, 'completed');
  assert.ok(confirmed.data.sale.reviewedBy);
  const after = (await admin.get('/api/kadiwa')).data.summary;
  assert.equal(Number(after.todaySales), Number(before.todaySales) + 1);
  assert.equal(Math.round((Number(after.totalNetSales) - Number(before.totalNetSales)) * 100), 27000);
  assert.ok((await admin.get(`/api/kadiwa/sales?from=${today}&to=${today}`)).data.sales.some((row) => row.id === again.data.sale.id));
  const audit = (await admin.get('/api/admin/audit-logs?action=KADIWA_SALE_CONFIRMED')).data.data[0];
  assert.equal(audit.entity_id, again.data.sale.id);
  assert.equal(audit.user_role_snapshot, 'ADMIN');
  assert.equal(audit.new_values.vendor, 'Rosa Vendor');
  assert.equal(audit.new_values.capital_change, '+270.00');
  const reviewed = (await vendor.get('/api/notifications')).data;
  assert.ok(JSON.stringify(reviewed).includes('Sale confirmed'));
  assert.ok(JSON.stringify(reviewed).includes('TALONG was 300'));

  // The administrator renames the vendor and changes the password: the vendor is signed out and uses the new one.
  assert.equal((await admin.patch(`/api/admin/accounts/vendors/${vendorId}`, { fullName: 'Rosa M. Vendor' })).status, 200);
  const memberUser = (await pool.query(`SELECT id FROM users WHERE role = 'MEMBER' LIMIT 1`)).rows[0];
  assert.equal((await admin.patch(`/api/admin/accounts/vendors/${memberUser.id}`, { fullName: 'Not A Vendor' })).status, 400, 'members are not renamed here');
  assert.equal((await admin.post(`/api/admin/accounts/vendors/${vendorId}/password`, { password: 'Vendor456!', confirmPassword: 'Vendor999!' })).status, 400);
  const changed = await admin.post(`/api/admin/accounts/vendors/${vendorId}/password`, { password: 'Vendor456!', confirmPassword: 'Vendor456!' });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await vendor.get('/api/vendor/kadiwa')).status, 401);
  assert.equal((await vendor.post('/api/auth/login', { usernameOrEmail: 'rosa.vendor', password: 'Vendor123!' })).status, 401);
  assert.equal((await vendor.post('/api/auth/login', { usernameOrEmail: 'rosa.vendor', password: 'Vendor456!' })).status, 200);
  const third = await vendor.post('/api/vendor/kadiwa/sales', sale);
  assert.equal(third.data.sale.seller, 'Rosa M. Vendor');
  const passwordAudit = (await admin.get('/api/admin/audit-logs?action=VENDOR_PASSWORD_CHANGED')).data.data[0];
  assert.equal(passwordAudit.entity_id, String(vendorId));
  assert.ok(!JSON.stringify(passwordAudit).includes('Vendor456!'));
  // Sent in parts at different times: one report for the day, confirmed or rejected together.
  const partOne = await vendor.post('/api/vendor/kadiwa/sales', sale);
  const partTwo = await vendor.post('/api/vendor/kadiwa/sales', { ...sale, goods: [] });
  const parts = (await admin.get('/api/kadiwa')).data.pendingSales.filter((row) => [partOne.data.sale.id, partTwo.data.sale.id].includes(row.id));
  assert.equal(parts.length, 2);
  assert.ok(parts.every((row) => row.createdBy === vendorId && row.saleDate === today));
  assert.equal((await admin.post('/api/kadiwa/sales/review', { ids: [partOne.data.sale.id, again.data.sale.id], decision: 'confirm' })).status, 409, 'all or none');
  assert.equal((await admin.get('/api/kadiwa')).data.pendingSales.filter((row) => parts.some((part) => part.id === row.id)).length, 2, 'nothing reviewed when one part cannot be');
  assert.equal((await admin.post('/api/kadiwa/sales/review', { ids: [], decision: 'confirm' })).status, 400);
  const both = await admin.post('/api/kadiwa/sales/review', { ids: [partOne.data.sale.id, partTwo.data.sale.id], decision: 'confirm' });
  assert.equal(both.status, 200, JSON.stringify(both.data));
  assert.deepEqual(both.data.sales.map((row) => row.status), ['completed', 'completed']);
  const partAudits = (await admin.get('/api/admin/audit-logs?action=KADIWA_SALE_CONFIRMED')).data.data.filter((row) => [partOne.data.sale.id, partTwo.data.sale.id].includes(row.entity_id));
  assert.equal(partAudits.length, 2, 'each part in the audit log');
  // Leave nothing pending for later tests.
  await admin.post(`/api/kadiwa/sales/${third.data.sale.id}/review`, { decision: 'reject', notes: 'Test' });
  await admin.post(`/api/kadiwa/sales/${storeOnly.data.sale.id}/review`, { decision: 'reject', notes: 'Test' });
  assert.equal(await stockOf(), startStock);
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
  await settleOpenLoans(state.memberId);
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

    // New loans: the one payment falls due on a day the office receives payments.
    process.env.LOAN_PAYMENT_HOURS = 'Mon-Fri 08:00-17:00';
    await settleOpenLoans(state.memberId);
    const released = await applyWithIds(admin, '/api/admin/loans', {
      loanType: 'agricultural', loanMode: 'cash', cashAmount: '2400', term: 12, farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay', cropsPlanted: 'Palay', certified: true, memberId: state.memberId,
    }, { acknowledgeIdWarnings: true });
    assert.equal(released.status, 201, JSON.stringify(released.data));
    const loanId = released.data.loan.databaseId;
    const detail = await admin.get(`/api/admin/loans/${loanId}`);
    const dueDates = detail.data.installments.map((row) => row.dueDate);
    assert.equal(dueDates.length, 1);
    assert.ok(dueDates.every((date) => isoDay(date) <= 5), JSON.stringify(dueDates));
    assert.equal(detail.data.loan.dueDate, dueDates.at(-1), 'the loan is due with its last installment');
    await pool.query('DELETE FROM loans WHERE id = $1', [loanId]);
  } finally {
    process.env.LOAN_PAYMENT_HOURS = 'Mon-Sun 00:00-24:00';
  }
});

test('loans: one open loan per member; an application once 80% is paid restructures it on approval', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const { refreshLoanStatuses } = await import('../src/services/loanService.js');
  const today = todayDateOnly();
  const plus = (days) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  await settleOpenLoans(state.memberId);
  for (const request of (await admin.get('/api/admin/loan-requests?status=pending&limit=100')).data.requests.filter((row) => Number(row.memberDatabaseId) === state.memberId)) {
    await admin.patch(`/api/admin/loan-requests/${request.id}`, { status: 'declined', reason: 'test cleanup' });
  }
  // Juan's open loan: PHP 10,250 with interest, nothing paid yet.
  const oldId = (await pool.query(
    `INSERT INTO loans (loan_number, member_id, member_name, loan_type, amount, balance, interest_rate, term, status, date_approved, due_date, monthly_payment, calculated_interest, total_repayment, repayment)
     VALUES ('L-ONE-001', $1, 'Juan Dela Cruz', 'agricultural', 10000, 10250, 2.5, 6, 'active', $2, $3, 10250, 250, 10250, 'single') RETURNING id`,
    [state.memberId, plus(-10), plus(170)]
  )).rows[0].id;
  await refreshLoanStatuses({ force: true });

  // A second loan is refused, from the member's form and from the office's New Loan.
  const application = { loanType: 'agricultural', amount: '20000', term: 12, purpose: 'Next cropping', farmArea: '2' };
  const early = await applyWithIds(member, '/api/members/me/loan-requests', application);
  assert.equal(early.status, 409, JSON.stringify(early.data));
  assert.match(early.data.message, /You have an open loan \(L-ONE-001\).*at least 80%.*PHP 8,200\.00 more/);
  const direct = await applyWithIds(admin, '/api/admin/loans', { loanType: 'agricultural', loanMode: 'cash', cashAmount: '20000', farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay', cropsPlanted: 'Palay', certified: true, memberId: state.memberId }, { acknowledgeIdWarnings: true });
  assert.equal(direct.status, 409, JSON.stringify(direct.data));
  assert.match(direct.data.message, /This member has an open loan \(L-ONE-001\)/);

  // With 80% paid the member may apply; the new loan must cover what is still owed.
  assert.equal((await admin.post(`/api/admin/loans/${oldId}/payments`, { amount: '8200', paymentDate: today })).status, 201);
  assert.equal((await applyWithIds(member, '/api/members/me/loan-requests', { ...application, amount: '2000' })).status, 400);
  const applied = await applyWithIds(member, '/api/members/me/loan-requests', application);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const request = (await admin.get('/api/admin/loan-requests?status=pending&limit=100')).data.requests.find((row) => row.id === applied.data.request.id);
  assert.deepEqual([request.openLoanNumber, request.openLoanBalance, request.openLoanTotal], ['L-ONE-001', '2050.00', '10250.00'], 'the office sees the loan it restructures');

  // Approving it restructures the open loan: the PHP 2,050 still owed is deducted.
  const approved = await admin.patch(`/api/admin/loan-requests/${applied.data.request.id}`, { status: 'approved' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const created = (await admin.get(`/api/admin/loans/${approved.data.loanId}`)).data.loan;
  assert.deepEqual([created.renewedFromLoan, created.renewalDeduction, created.netProceeds, created.amount], ['L-ONE-001', '2050.00', '17950.00', '20000.00']);
  const old = (await admin.get(`/api/admin/loans/${oldId}`)).data;
  assert.deepEqual([old.loan.status, old.loan.balance, old.restructurings[0].kind, old.restructurings[0].newLoanNumber], ['paid', '0.00', 'renewal', created.id]);
  assert.match(old.restructurings[0].reason, /approval of loan application/);
  const told = (await pool.query(`SELECT message FROM notifications WHERE user_id = $1 AND type = 'loan_approved' ORDER BY id DESC LIMIT 1`, [state.memberUserId])).rows[0].message;
  assert.match(told, /L-ONE-001 was restructured.*you receive PHP 17,950\.00/);
  // The audit log records how each step changed the capital: the payment in, the money released out.
  const capitalLog = async (action, entityId) => (await pool.query(`SELECT new_values ->> 'capital_change' AS change FROM audit_logs WHERE action = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`, [action, String(entityId)])).rows[0]?.change;
  const paymentId = old.payments.find((row) => row.amount === '8200.00').id;
  assert.equal(await capitalLog('PAYMENT_CREATED', paymentId), '+8200.00');
  assert.equal(await capitalLog('LOAN_APPROVED', applied.data.request.id), '-17950.00', 'only what the member received leaves the cooperative');
  await settleOpenLoans(state.memberId);
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
  assert.deepEqual(forms.data.data.map((form) => form.type), ['Membership Form', 'Loan Form', 'Savings Form', 'Machinery Form', 'Add Inventory Form', 'Kadiwa Daily Sales Form', 'Kadiwa Sales Form']);

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

test('ocr: the printed Kadiwa forms add products to the inventory and record a sale', { skip }, async () => {
  const genuine = { score: 95, verdict: 'genuine', physicalDocument: true, filledIn: true, signaturePresent: true, issues: [] };
  let counter = 200;
  const scan = async (analysis) => {
    stubAnalysis = analysis;
    counter += 1;
    const form = new FormData();
    form.append('source', 'camera');
    form.append('document', new Blob([Buffer.concat([PNG, Buffer.from([counter % 256, counter >> 8])])], { type: 'image/png' }), `kadiwa-${counter}.png`);
    const response = await admin.request('POST', '/api/ocr/analyze', { form });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.data;
  };
  const check = (scanned, id) => scanned.verification.checks.find((item) => item.id === id);
  const inventoryForm = (extractedData) => ({
    documentType: 'Add Inventory Form', confidence: 95, ocrText: 'ADD INVENTORY FORM KADIWA-INV', authenticity: genuine,
    extractedData: { date: '2026-01-20', preparedBy: 'Maria', category: 'groceries', lowStockAt: '4', ...extractedData },
  });
  const inventory = async () => (await admin.get('/api/kadiwa')).data.inventory;

  // A form whose lines and total add up is saved to the inventory on its own.
  const added = await scan(inventoryForm({
    line1Product: 'OCR Corned Beef', line1Size: '150g', line1Quantity: '12', line1Unit: 'cans', line1SellingPrice: '45', line1CostPrice: '40', line1Total: '480',
    line2Product: 'OCR Coffee 3in1', line2Quantity: '50', line2Unit: 'sachet', line2SellingPrice: '8', line2CostPrice: '6.50', line2Total: '325', grandTotal: '805',
  }));
  assert.equal(added.posted?.module, 'kadiwa', JSON.stringify(added.verification));
  const beef = (await inventory()).find((item) => item.name === 'OCR Corned Beef');
  assert.equal(Number(beef.sizeValue), 150);
  assert.equal(beef.sizeUnit, 'g');
  assert.equal(beef.unit, 'can');
  assert.equal(Number(beef.stock), 12);
  assert.equal(Number(beef.costPrice), 40);
  assert.equal(Number(beef.reorderLevel), 4);
  assert.equal(beef.category, 'Groceries');
  assert.ok((await inventory()).some((item) => item.name === 'OCR Coffee 3in1' && item.unit === 'sachet' && Number(item.stock) === 50));

  // A total that does not add up holds the form for review; the admin can still save it.
  const held = await scan(inventoryForm({ line1Product: 'OCR Rice', line1Size: '1 kg', line1Quantity: '10', line1Unit: 'pack', line1SellingPrice: '60', line1CostPrice: '52', line1Total: '500' }));
  assert.equal(held.posted, null);
  assert.equal(check(held, 'totals').status, 'warn');
  assert.match(check(held, 'totals').message, /10 × PHP 52\.00 = PHP 520\.00, but the form says PHP 500\.00/);
  const saved = await admin.post(`/api/ocr/${held.id}/post`, { documentType: 'Add Inventory Form', extractedData: held.extractedData, acknowledgeWarnings: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok((await inventory()).some((item) => item.name === 'OCR Rice' && Number(item.stock) === 10));

  // A product already in the inventory is refused by the inventory's own rules.
  const again = await scan(inventoryForm({ date: '2026-01-21', line1Product: 'OCR Corned Beef', line1Size: '150 g', line1Quantity: '5', line1Unit: 'can', line1SellingPrice: '45', line1CostPrice: '40', line1Total: '200' }));
  assert.equal(again.posted, null);
  assert.equal(again.verification.status, 'failed');
  assert.match(check(again, 'rules').message, /already in the inventory/);

  // The daily sales form: goods, a store item by its printed code, and the expenses.
  const salesForm = (extractedData) => ({
    documentType: 'Kadiwa Daily Sales Form', confidence: 94, ocrText: 'DAILY SALES FORM KADIWA-SALES', authenticity: genuine,
    extractedData: { saleDate: '2026-01-21', preparedBy: 'Maria Santos', ...extractedData },
  });
  const sold = await scan(salesForm({
    good1Name: 'PORK', good1Unit: 'KILO', good1Price: '400', good1Quantity: '1.5', good1Amount: '600',
    store1Code: beef.id, store1Product: 'OCR Corned Beef 150 g (can)', store1Quantity: '2', store1Amount: '90',
    expense1Description: 'Ice', expense1Amount: '20', totalGoodsSold: '690', totalExpenses: '20', netIncome: '670',
  }));
  assert.equal(sold.posted?.module, 'kadiwa', JSON.stringify(sold.verification));
  const day = (await admin.get('/api/kadiwa/sales?from=2026-01-21&to=2026-01-21')).data.sales;
  const sale = day.find((entry) => entry.id === sold.posted.recordId);
  assert.equal(sale.seller, 'Maria Santos');
  assert.deepEqual(sale.goods.map((good) => [good.name, Number(good.amount)]), [['PORK', 600]]);
  assert.deepEqual(sale.items.map((item) => [item.inventoryId, Number(item.quantity)]), [[beef.id, 2]]);
  assert.deepEqual(sale.expenses.map((line) => [line.description, Number(line.amount)]), [['Ice', 20]]);
  assert.equal(Number(sale.netSales), 690 - 20 - 80);
  assert.equal(Number((await inventory()).find((item) => item.id === beef.id).stock), 10);

  // A store item that is not in the inventory cannot be saved.
  const unknown = await scan(salesForm({ saleDate: '2026-01-22', good1Name: 'TALONG', good1Amount: '100', store1Code: 'INV-9999', store1Product: 'Mystery Soap', store1Quantity: '1' }));
  assert.equal(unknown.posted, null);
  assert.equal(check(unknown, 'storeItems').status, 'fail');
  stubAnalysis = DEFAULT_STUB_ANALYSIS;
});

test('ocr: the paper Agri loan form becomes a pending loan application', { skip }, async () => {
  await settleOpenLoans(state.memberId);
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
    // The form is read twice at the same time; each reading falls back the same way.
    assert.deepEqual([...geminiCalls].sort(), ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-latest']);

    // The next scan goes straight to the model that answered; the failed ones are resting.
    const nextScan = await admin.request('POST', '/api/ocr/analyze', { form: scanFile([203], 'next.png') });
    assert.equal(nextScan.status, 201, JSON.stringify(nextScan.data));
    assert.deepEqual(geminiCalls.slice(6), ['gemini-flash-latest', 'gemini-flash-latest']);
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

test('ocr automation: two readings must agree, busy scans are read again by the queue, automatic saves can be undone', { skip }, async () => {
  const memberNumber = (await admin.get(`/api/members/${state.memberId}`)).data.data.member_number;
  const genuine = { score: 95, verdict: 'genuine', physicalDocument: true, filledIn: true, signaturePresent: true, photoRecognized: true, issues: [] };
  const savings = (reference, overrides = {}) => ({
    documentType: 'Savings Form', confidence: 94, ocrText: 'ACIFAC SAVINGS DEPOSIT', authenticity: genuine,
    extractedData: { memberNumber, memberName: 'Juan Dela Cruz', amount: '200.00', date: '2026-01-21', paymentMethod: 'cash', referenceNumber: reference, ...overrides },
  });
  const upload = async (byte) => {
    const form = new FormData();
    form.append('source', 'camera');
    form.append('document', new Blob([Buffer.concat([PNG, Buffer.from([0xa0, byte])])], { type: 'image/png' }), `auto-${byte}.png`);
    const response = await admin.request('POST', '/api/ocr/analyze', { form });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data.data;
  };
  const makeDue = (id) => pool.query('UPDATE document_scans SET next_retry_at = NOW() - INTERVAL \'1 second\' WHERE id = $1', [id]);
  const notifications = async (type, id) => (await pool.query('SELECT title FROM notifications WHERE type = $1 AND entity_id = $2', [type, String(id)])).rows;

  try {
    // The two readings disagree on the amount: the form is held and the amount is flagged.
    stubAnalysis = savings('SV-AUTO-1');
    stubSecondReading = savings('SV-AUTO-1', { amount: '2000.00' });
    const held = await upload(1);
    assert.equal(held.posted, null);
    assert.equal(held.verification.status, 'warning');
    const agreement = held.verification.checks.find((check) => check.id === 'agreement');
    assert.equal(agreement.status, 'warn', JSON.stringify(held.verification));
    assert.deepEqual(agreement.fields, ['amount']);
    // The confidence shown is the share of checks passed, not the AI's 94.
    assert.ok(held.confidence < 100 && held.confidence > 50, String(held.confidence));
    assert.equal(held.aiConfidence, 94);
    // The admin corrects the amount from the paper form: the corrected value counts as checked.
    const corrected = await admin.patch(`/api/ocr/${held.id}/review`, { documentType: 'Savings Form', extractedData: { ...held.extractedData, amount: '2000.00' } });
    assert.equal(corrected.data.data.verification.checks.find((check) => check.id === 'agreement').status, 'pass');
    stubSecondReading = null;

    // Only the second reading failed: the scan is queued, then the queue reads it again and saves it.
    secondMode = 'fail';
    stubAnalysis = savings('SV-AUTO-2');
    const once = await upload(3);
    assert.equal(once.posted, null);
    assert.ok(once.retry.nextAt, JSON.stringify(once.retry));
    assert.equal(once.verification.checks.find((check) => check.id === 'agreement').status, 'warn');
    secondMode = 'ok';
    assert.deepEqual((await admin.post('/api/ocr/retry-due')).data.data, []);
    await makeDue(once.id);
    const second = await admin.post('/api/ocr/retry-due');
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.data[0].id, once.id);
    assert.equal(second.data.data[0].posted?.automatically, true, JSON.stringify(second.data.data[0].verification));
    assert.equal(second.data.data[0].retry.nextAt, null);

    // The AI is busy for the whole reading: the scan is kept and read again by the queue, then saved and announced.
    stubMode = 'fail';
    stubAnalysis = savings('SV-AUTO-3');
    const failed = await upload(4);
    assert.equal(failed.processingStatus, 'failed');
    assert.equal(failed.retry.count, 1);
    assert.ok(new Date(failed.retry.nextAt) > new Date());
    await makeDue(failed.id);
    const stillBusy = await admin.post('/api/ocr/retry-due');
    assert.equal(stillBusy.data.data[0].retry.count, 2);
    assert.ok(stillBusy.data.data[0].retry.nextAt);
    stubMode = 'ok';
    await makeDue(failed.id);
    const reread = (await admin.post('/api/ocr/retry-due')).data.data[0];
    assert.equal(reread.processingStatus, 'completed');
    assert.equal(reread.posted?.automatically, true, JSON.stringify(reread.verification));
    assert.match((await notifications('ocr_auto_posted', failed.id))[0]?.title || '', /Savings deposit auto-recorded/);
    // A savings deposit is corrected in Savings, not undone here.
    assert.equal((await admin.post(`/api/ocr/${failed.id}/undo`)).status, 409);

    // After the last automatic try the admins are told and the scan waits for Retry.
    stubMode = 'fail';
    stubAnalysis = savings('SV-AUTO-4');
    const stuck = await upload(5);
    await pool.query('UPDATE document_scans SET retry_count = 6 WHERE id = $1', [stuck.id]);
    await makeDue(stuck.id);
    const gaveUp = (await admin.post('/api/ocr/retry-due')).data.data[0];
    assert.equal(gaveUp.retry.nextAt, null);
    assert.equal((await notifications('ocr_failed', stuck.id)).length, 1);
    stubMode = 'ok';

    // A membership form that passes every check registers the member automatically; the admin can undo it.
    const applicant = {
      lastName: 'Villanueva', firstName: 'Lorna', email: 'lorna.auto@example.com', phone: '+63 917 555 0101', dateOfBirth: '1988-06-02',
      address: 'Purok 1', barangay: 'Barahan', municipality: 'Sta. Cruz', province: 'Occidental Mindoro',
    };
    stubAnalysis = { documentType: 'Membership Form', confidence: 96, ocrText: 'ACIFAC ASSOCIATE MEMBERSHIP FORM', extractedData: applicant, authenticity: genuine };
    const membership = await upload(6);
    assert.equal(membership.extractedData.phone, '09175550101');
    stubIdReading = {
      isId: true, idType: 'PhilSys National ID', idNumber: '5555-0101-2026', name: 'LORNA VILLANUEVA', dateOfBirth: '1988-06-02',
      frontVisible: true, backVisible: true, photocopy: false, physicalCard: true, screen: false, signatureCount: 0, expired: false, issues: [],
    };
    const idForm = new FormData();
    idForm.append('source', 'camera');
    idForm.append('idDocument', new Blob([Buffer.concat([PNG, Buffer.from([0xa1, 1])])], { type: 'image/png' }), 'lorna-id.png');
    const withId = (await admin.request('POST', `/api/ocr/${membership.id}/id-document`, { form: idForm })).data.data;
    // Barahan, Sta. Cruz is in the service area: Rosa Magsaysay, scanned earlier, lives there.
    assert.equal(withId.posted?.module, 'members', JSON.stringify(withId.verification.checks.filter((check) => check.status !== 'pass')));
    assert.ok(withId.verification.checks.some((check) => check.id === 'area' && check.status === 'pass'));
    assert.ok(withId.posted.undoUntil);
    assert.match((await notifications('ocr_auto_posted', membership.id))[0]?.title || '', /^New member auto-registered: Lorna Villanueva/);
    const undone = await admin.post(`/api/ocr/${membership.id}/undo`);
    assert.equal(undone.status, 200, JSON.stringify(undone.data));
    assert.equal(undone.data.data.posted, null);
    assert.equal(undone.data.data.reviewStatus, 'needs_review');
    assert.equal(undone.data.data.undone.recordId, withId.posted.recordId);
    assert.equal((await pool.query('SELECT 1 FROM members WHERE member_number = $1', [withId.posted.recordId])).rowCount, 0);
    assert.equal((await admin.post(`/api/ocr/${membership.id}/undo`)).status, 409);
    // Checked again it is not saved by itself a second time.
    const rechecked = await admin.post(`/api/ocr/${membership.id}/verify`);
    assert.equal(rechecked.data.data.posted, null);

    // A barangay where no member lives yet is flagged, with the closest known one suggested.
    stubAnalysis = { ...stubAnalysis, extractedData: { ...applicant, firstName: 'Nena', email: 'nena.auto@example.com', barangay: 'Barahn' } };
    const typo = await upload(8);
    const area = typo.verification.checks.find((check) => check.id === 'area');
    assert.equal(area.status, 'warn');
    assert.match(area.message, /did the form say Barahan/);
    assert.deepEqual(area.fields, ['barangay']);

    // An applicant under 18 fails, with the birthday highlighted; a CP No. that is not a mobile number fails too.
    stubAnalysis = { ...stubAnalysis, extractedData: { ...applicant, firstName: 'Mika', email: 'mika.auto@example.com', dateOfBirth: '2015-01-01', phone: '288-1234' } };
    const child = await upload(7);
    const adult = child.verification.checks.find((check) => check.id === 'adult');
    assert.equal(adult.status, 'fail');
    assert.deepEqual(adult.fields, ['dateOfBirth']);
    const format = child.verification.checks.find((check) => check.id === 'format');
    assert.equal(format.status, 'fail');
    assert.deepEqual(format.fields, ['phone']);

    // Every flagged scan is rejected at once; saved, held-for-warnings and queued scans are left alone.
    stubMode = 'fail';
    stubAnalysis = savings('SV-AUTO-5');
    const queuedScan = await upload(9);
    stubMode = 'ok';
    const bulk = await admin.post('/api/ocr/reject-flagged');
    assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
    const rejectedIds = bulk.data.data.map((scan) => scan.id);
    assert.ok(rejectedIds.includes(child.id));
    assert.ok(bulk.data.data.every((scan) => scan.reviewStatus === 'rejected' && !scan.posted));
    for (const kept of [held.id, once.id, queuedScan.id, membership.id]) assert.ok(!rejectedIds.includes(kept), String(kept));
    assert.deepEqual((await admin.post('/api/ocr/reject-flagged')).data.data, []);

    // A scan that is not needed can be deleted with its file; one saved to records cannot.
    const removed = await admin.request('DELETE', `/api/ocr/${child.id}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal((await pool.query('SELECT 1 FROM document_scans WHERE id = $1', [child.id])).rowCount, 0);
    assert.equal((await admin.request('GET', `/api/ocr/${child.id}/file`, { raw: true })).status, 404);
    assert.equal((await admin.request('DELETE', `/api/ocr/${once.id}`)).status, 409);
    assert.equal((await admin.request('DELETE', `/api/ocr/${child.id}`)).status, 404);
  } finally {
    stubMode = 'ok';
    secondMode = 'ok';
    stubSecondReading = null;
    stubAnalysis = DEFAULT_STUB_ANALYSIS;
  }
});

test('member emails: savings, share capital, loan application, scanned forms, opt-out', { skip }, async () => {
  await settleOpenLoans(state.memberId);
  // One pending application at a time (agricultural loans only).
  for (const request of (await admin.get('/api/admin/loan-requests?status=pending&limit=100')).data.requests.filter((row) => Number(row.memberDatabaseId) === state.memberId)) {
    await admin.patch(`/api/admin/loan-requests/${request.id}`, { status: 'declined', reason: 'test cleanup' });
  }
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
  const applied = await applyWithIds(member, '/api/members/me/loan-requests', { loanType: 'agricultural', loanMode: 'cash', purpose: 'Seeds', amount: '5000', term: '6', farmArea: '2', borrowerPhone: '09171234567', borrowerAddress: 'Purok 1, Amnay' });
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

  // Done: off the list, kept on record, the members' notification stays in their history.
  const doneId = announcement.data.data.id;
  const memberHas = async (id) => (await member.get('/api/notifications?limit=100')).data.data.some((note) => note.entityType === 'announcement' && String(note.entityId) === String(id));
  assert.ok(await memberHas(doneId), 'the member was notified of the announcement');
  assert.equal((await member.patch(`/api/announcements/${doneId}/done`)).status, 403);
  assert.equal((await admin.patch(`/api/announcements/${doneId}/done`)).status, 200);
  assert.ok(!(await admin.get('/api/announcements')).data.data.some((row) => row.id === doneId), 'a done announcement leaves the list');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM announcements WHERE id = $1 AND archived_at IS NOT NULL', [doneId])).rows[0].n, 1, 'and stays on record');
  assert.ok(await memberHas(doneId), 'the notification already sent stays');
  assert.equal((await admin.patch(`/api/announcements/${doneId}/done`)).status, 404, 'already done');

  // Delete: gone for everyone, notifications included; the audit log keeps its text.
  const mistake = (await admin.post('/api/announcements', { title: 'Wrong date', message: 'Posted by mistake', audience: 'All Members' })).data.data;
  assert.ok(await memberHas(mistake.id));
  assert.equal((await member.delete(`/api/announcements/${mistake.id}`)).status, 403);
  const deleted = await admin.delete(`/api/announcements/${mistake.id}`);
  assert.equal(deleted.status, 200);
  assert.ok(deleted.data.data.notificationsRemoved >= 1);
  assert.ok(!(await member.get('/api/announcements')).data.data.some((row) => row.id === mistake.id));
  assert.ok(!(await memberHas(mistake.id)), 'the member\'s notification is removed too');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM announcements WHERE id = $1', [mistake.id])).rows[0].n, 0);
  const audit = (await pool.query(`SELECT old_values FROM audit_logs WHERE action = 'ANNOUNCEMENT_DELETED' AND entity_id = $1`, [String(mistake.id)])).rows[0];
  assert.equal(audit.old_values.title, 'Wrong date');
  assert.equal((await admin.delete(`/api/announcements/${mistake.id}`)).status, 404);

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
  // The loans paid off so far (tests that lend again settle the member's open loan).
  assert.equal(analytics.data.summary.completedLoans, (await pool.query(`SELECT COUNT(*)::int AS count FROM loans WHERE status = 'paid'`)).rows[0].count);
  assert.equal(analytics.data.summary.totalLoanPayments, Number((await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM loan_payments')).rows[0].total));
  const juan = analytics.data.memberAnalytics.find((row) => row.databaseId === state.memberId);
  assert.equal(juan.totalPaid, Number((await pool.query('SELECT COALESCE(SUM(p.amount), 0) AS total FROM loan_payments p JOIN loans l ON l.id = p.loan_id WHERE l.member_id = $1', [state.memberId])).rows[0].total));
  assert.ok(analytics.data.methodology.onTimePaymentRate);

  // Loan disbursement: every month (0 without a loan), each with its change from the month before.
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const thisMonth = todayDateOnly().slice(0, 7);
  const year = thisMonth.slice(0, 4);
  const monthAfter = (month) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
  const checkMonths = (rows) => rows.forEach((row, index) => {
    if (index > 0) assert.equal(row.month, monthAfter(rows[index - 1].month), 'consecutive months');
    if (index > 0) assert.equal(row.previous, rows[index - 1].amount);
    assert.equal(Math.round(row.change * 100), Math.round((row.amount - row.previous) * 100));
    if (row.previous > 0) assert.ok(Math.abs(row.changePercent - ((row.amount - row.previous) / row.previous) * 100) <= 0.05, `${row.month} percent`);
    else assert.equal(row.changePercent, null, 'no percentage of a month without loans');
  });
  const yearRows = (await admin.get(`/api/admin/analytics?from=${year}-01-01&to=${year}-12-31`)).data.loans;
  assert.equal(yearRows[0].month, `${year}-01`, 'a year shows its own months');
  assert.equal(yearRows.at(-1).month, thisMonth, 'never past the current month');
  checkMonths(yearRows);
  const disbursed = (await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM loans WHERE date_approved BETWEEN $1 AND $2`, [`${year}-01-01`, `${year}-12-31`])).rows[0].total;
  assert.equal(Math.round(yearRows.reduce((sum, row) => sum + row.amount, 0) * 100), Math.round(Number(disbursed) * 100));
  assert.ok(yearRows.some((row) => row.amount > 0), 'the loans in these tests were approved this year');
  const monthRows = (await admin.get(`/api/admin/analytics?from=${thisMonth}-01&to=${thisMonth}-28`)).data.loans;
  assert.equal(monthRows.length, 12, 'a month shows the 12 months up to it');
  assert.equal(monthRows.at(-1).month, thisMonth);
  checkMonths(monthRows);
  assert.deepEqual((await admin.get(`/api/admin/analytics?from=${Number(year) + 1}-01-01&to=${Number(year) + 1}-12-31`)).data.loans, [], 'nothing for a year still to come');

  // Revenue over time: 30 days, 12 months or 5 years, each source adding up to the Operating revenue figures.
  const todayDate = todayDateOnly();
  const trend = {};
  for (const granularity of ['day', 'month', 'year']) {
    const response = await admin.get(`/api/admin/analytics/revenue?granularity=${granularity}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    trend[granularity] = response.data;
    assert.equal(response.data.rows.length, { day: 30, month: 12, year: 5 }[granularity], `${granularity}: every ${granularity} of the window`);
    assert.equal(response.data.to, todayDate);
    for (const row of response.data.rows) assert.equal(Math.round(row.total * 100), Math.round((row.kadiwa + row.machinery + row.loanInterest) * 100));
  }
  assert.equal(trend.day.rows.at(-1).start, todayDate);
  assert.equal(trend.month.rows.at(-1).start, `${thisMonth}-01`);
  assert.equal(trend.year.rows.at(-1).start, `${year}-01-01`);
  assert.equal(trend.year.rows[0].start, `${Number(year) - 4}-01-01`);
  // Net income as the Dashboard counts it (machinery: rentals + service fees + other income
  // - expenses), over the same days as the chart.
  const sameWindow = (await admin.get(`/api/admin/analytics?from=${trend.year.from}&to=${todayDate}`)).data.summary;
  assert.equal(Math.round(trend.year.totals.kadiwa * 100), Math.round(sameWindow.kadiwaNetSales * 100));
  assert.equal(Math.round(trend.year.totals.machinery * 100), Math.round(sameWindow.machineryNetIncome * 100));
  assert.equal(Math.round(trend.year.totals.loanInterest * 100), Math.round(sameWindow.interestCollected * 100));
  assert.equal(Math.round(trend.year.totals.total * 100), Math.round(sameWindow.netIncome * 100));
  assert.ok(trend.year.totals.total > 0, 'these tests recorded income this year');
  assert.notEqual(Math.round(sameWindow.machineryNetIncome * 100), Math.round(sameWindow.machineryRevenue * 100), 'service fees and expenses count, not only rentals');
  // Over all time, the Analytics net income is the Dashboard's.
  const allTime = (await admin.get('/api/admin/analytics?from=2000-01-01&to=2999-12-31')).data.summary;
  assert.equal(Math.round(allTime.netIncome * 100), Math.round((await admin.get('/api/admin/dashboard')).data.stats.netIncome * 100));
  // An earlier end date moves the window; a later one stops at today.
  const march = (await admin.get(`/api/admin/analytics/revenue?granularity=month&to=${year}-03-15`)).data;
  assert.deepEqual([march.rows[0].start, march.rows.at(-1).start, march.rows.at(-1).label], [`${Number(year) - 1}-04-01`, `${year}-03-01`, `Mar ${year}`]);
  assert.equal((await admin.get(`/api/admin/analytics/revenue?granularity=day&to=${Number(year) + 1}-01-01`)).data.to, todayDate);
  assert.equal((await admin.get('/api/admin/analytics/revenue?granularity=week')).status, 400);
  assert.equal((await member.get('/api/admin/analytics/revenue')).status, 403);

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
  // And what is shared out to the members: 35% each for dividends and patronage refunds.
  const incomeShares = dashboard.data.stats.netIncomeShares;
  assert.deepEqual(incomeShares.map(({ key, percent }) => [key, percent]), [['dividends', 35], ['patronage', 35]]);
  const netCents = Math.round(Math.max(0, netIncome) * 100);
  const fundCents = dashboard.data.stats.statutoryFunds.reduce((sum, fund) => sum + Math.round(fund.amount * 100), 0);
  assert.equal(incomeShares.reduce((sum, share) => sum + Math.round(share.amount * 100), 0) + fundCents, netCents, 'the funds and the two shares add up to the net income');
  assert.ok(Math.abs(Math.round(incomeShares[0].amount * 100) - Math.round(netCents * 0.35)) <= 1);
  // The Capital card: where the cooperative's money is, by module, and their total.
  const capital = dashboard.data.stats.capital;
  assert.deepEqual(capital.parts.map((part) => part.key), ['shareCapital', 'savings', 'loans', 'machinery', 'kadiwa']);
  const byKey = Object.fromEntries(capital.parts.map((part) => [part.key, part.amount]));
  const sql = (await pool.query(`SELECT
      (SELECT COALESCE(SUM(sc.amount), 0) FROM share_contributions sc JOIN members m ON m.id = sc.member_id WHERE m.status <> 'archived') AS shares,
      (SELECT COALESCE(SUM(CASE WHEN transaction_type = 'withdrawal' THEN -amount ELSE amount END), 0) FROM savings_transactions) AS savings,
      (SELECT COALESCE(SUM(amount), 0) FROM loan_payments) - (SELECT COALESCE(SUM(amount), 0) FROM loans) AS loans`)).rows[0];
  assert.deepEqual([byKey.shareCapital, byKey.savings, byKey.loans], [Number(sql.shares), Number(sql.savings), Number(sql.loans)]);
  assert.deepEqual([byKey.machinery, byKey.kadiwa], [parts.machinery, parts.kadiwa], 'the same cash as in the net income');
  assert.equal(Math.round(capital.total * 100), capital.parts.reduce((sum, part) => sum + Math.round(part.amount * 100), 0));

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

  // The patronage refund: the pool shared 70/30 by business points (1 per PHP
  // 100 of machinery fees and loan interest) and attendance points.
  const p = d.patronage;
  assert.deepEqual(p.rules, { pesosPerBusinessPoint: 100, activityPoints: { meeting: 10, community_development: 5, education_training: 5 } });
  const interest = (await pool.query(
    `SELECT COALESCE(SUM(lp.interest_paid) FILTER (WHERE l.member_id = $1), 0) AS member, COALESCE(SUM(lp.interest_paid), 0) AS total
     FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id JOIN members m ON m.id = l.member_id
     WHERE m.status <> 'archived' AND lp.payment_date BETWEEN $2 AND $3`,
    [state.memberId, d.from, d.asOf]
  )).rows[0];
  assert.equal(p.business.loans, Number(interest.member));
  assert.ok(p.business.loans > 0, 'the member paid loan interest this year');
  // Kadiwa Store purchases written on the day's sales count too (see the member purchases test).
  const purchases = (await pool.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS member FROM kadiwa_sale_members p JOIN kadiwa_sales s ON s.id = p.sale_id
     WHERE p.member_id = $1 AND s.status = 'completed' AND s.sale_date BETWEEN $2 AND $3`, [state.memberId, d.from, d.asOf]
  )).rows[0];
  assert.equal(p.business.kadiwa, Number(purchases.member));
  assert.ok(p.business.kadiwa >= 650, 'the member bought at the Kadiwa Store this year');
  assert.equal(cents(p.business.machinery + p.business.loans + p.business.kadiwa), cents(p.business.total));
  assert.ok(Math.abs(p.businessPoints - p.business.total / 100) < 1e-9);
  assert.ok(p.totalBusiness >= Number(interest.total) && p.totalBusiness >= p.business.total);
  assert.equal(p.businessShare, p.business.total / p.totalBusiness);
  if (d.patronageRefundPool > 0) {
    assert.ok([70, 100].includes(p.weights.business), JSON.stringify(p.weights));
    assert.equal(p.weights.business + p.weights.participation, 100);
    assert.equal(cents(p.businessPool + p.participationPool), cents(d.patronageRefundPool));
  }
  assert.equal(p.businessRefund, Math.round(p.businessPool * p.businessShare * 100) / 100);
  assert.equal(cents(p.refund), cents(p.businessRefund) + cents(p.participationRefund));
  const lastYear = await member.get(`/api/members/me/dividend?year=${d.year - 1}`);
  assert.equal(lastYear.status, 200);
  assert.equal(lastYear.data.data.asOf, `${d.year - 1}-12-31`);
  assert.equal(lastYear.data.data.yearComplete, true);
  for (const year of ['1999', String(d.year + 1), 'abc']) assert.equal((await member.get(`/api/members/me/dividend?year=${year}`)).status, 400, year);
  assert.equal((await admin.get('/api/members/me/dividend')).status, 403, 'only a member sees their own dividend');

  // The loan summary and history: the member sees in their account what the admin opens from Loans & Payments.
  const mine = await member.get('/api/members/me/loan-history');
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  const theirs = (await admin.get(`/api/admin/members/${state.memberId}/loan-history`)).data;
  assert.deepEqual(mine.data.summary, theirs.summary);
  assert.deepEqual(mine.data.loans.map((loan) => loan.id), theirs.loans.map((loan) => loan.id));
  assert.ok(mine.data.loans.length > 0 && mine.data.payments.length > 0);
  assert.equal(mine.data.summary.totalPaid, (mine.data.payments.reduce((total, payment) => total + Math.round(Number(payment.amount) * 100), 0) / 100).toFixed(2));
  assert.equal((await admin.get('/api/members/me/loan-history')).status, 403, 'an admin has no member record of their own');
  assert.ok([401, 403].includes((await member.get(`/api/admin/members/${state.memberId}/loan-history`)).status), 'a member sees only their own');
});

test('loans: the office keeps a farm input price list the in-kind table offers', { skip }, async () => {
  const url = '/api/admin/farm-inputs';
  const urea = { category: 'fertilizer', name: 'Urea 46-0-0', unit: 'bag', unitPrice: '1650' };
  assert.ok([401, 403].includes((await member.post(url, urea)).status), 'only the office edits the list');
  for (const bad of [{ ...urea, category: 'tools' }, { ...urea, name: ' ' }, { ...urea, unit: '' }, { ...urea, unitPrice: '0' }, { ...urea, unitPrice: '1.234' }]) {
    assert.equal((await admin.post(url, bad)).status, 400, JSON.stringify(bad));
  }
  const created = await admin.post(url, urea);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual([created.data.item.category, created.data.item.name, created.data.item.unit, created.data.item.unitPrice, created.data.item.active], ['fertilizer', 'Urea 46-0-0', 'bag', '1650.00', true]);
  assert.equal((await admin.post(url, { ...urea, name: 'urea 46-0-0 ', unit: 'BAG' })).status, 409, 'the same product and unit once');
  const seeds = await admin.post(url, { category: 'seeds', name: 'Hybrid rice seeds', unit: 'bag', unitPrice: '5200.50' });
  assert.equal(seeds.status, 201);

  // A new price; then the product is hidden from the form.
  const id = created.data.item.id;
  const repriced = await admin.put(`${url}/${id}`, { unitPrice: '1725.75' });
  assert.equal(repriced.status, 200, JSON.stringify(repriced.data));
  assert.equal(repriced.data.item.unitPrice, '1725.75');
  assert.equal((await admin.put(`${url}/${id}`, {})).status, 400);
  assert.equal((await admin.put(`${url}/999999`, { unitPrice: '1' })).status, 404);
  const listed = (await member.get('/api/loans/farm-inputs')).data.items;
  assert.deepEqual(listed.map((item) => [item.category, item.name, item.unitPrice]), [['fertilizer', 'Urea 46-0-0', '1725.75'], ['seeds', 'Hybrid rice seeds', '5200.50']], 'in the order of the form');
  assert.equal((await admin.put(`${url}/${id}`, { active: false })).status, 200);
  assert.deepEqual((await member.get('/api/loans/farm-inputs?all=true')).data.items.map((item) => item.name), ['Hybrid rice seeds'], 'a member sees only what is offered');
  assert.deepEqual((await admin.get('/api/loans/farm-inputs?all=true')).data.items.map((item) => [item.name, item.active]), [['Urea 46-0-0', false], ['Hybrid rice seeds', true]]);
  const audit = (await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'farm_input_price' ORDER BY id`)).rows.map((row) => row.action);
  assert.deepEqual(audit, ['FARM_INPUT_CREATED', 'FARM_INPUT_CREATED', 'FARM_INPUT_UPDATED', 'FARM_INPUT_UPDATED']);
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

  // The audit log names whoever did each action by full name: an administrator's
  // profile name, a member's name from their member record; the username stays too.
  const adminId = (await admin.get('/api/auth/me')).data.user.id;
  const logs = (await admin.get('/api/admin/audit-logs?limit=100')).data.data;
  const byAdmin = logs.find((row) => row.user_id === adminId);
  assert.equal(byAdmin.user_full_name, 'Coop Admin');
  assert.ok(byAdmin.user_name_snapshot);
  const byMember = (await admin.get(`/api/admin/audit-logs?userId=${state.memberUserId}&limit=5`)).data.data[0];
  assert.equal(byMember.user_full_name, 'Juan Dela Cruz');
  const found = (await admin.get('/api/admin/audit-logs?search=Coop%20Admin&limit=5')).data.data;
  assert.ok(found.length > 0 && found.every((row) => row.user_full_name === 'Coop Admin' || /Coop Admin/.test(row.description)), 'searchable by full name');
  // Entries from before the name was kept with them show the person's current name.
  await pool.query('UPDATE audit_logs SET user_full_name_snapshot = NULL WHERE id = $1', [byAdmin.id]);
  assert.equal((await admin.get('/api/admin/audit-logs?limit=100')).data.data.find((row) => row.id === byAdmin.id).user_full_name, 'Coop Admin');
  const system = logs.find((row) => row.user_id === null);
  if (system) assert.equal(system.user_full_name, null, 'system actions have no person');
});

test('administrator accounts: name and position required, email and mobile verified and unique, audit log by position', { skip }, async () => {
  const codeIn = (text) => /(\d{6})/.exec(text)?.[1];
  const memberEmail = (await pool.query('SELECT email FROM members WHERE id = $1', [state.memberId])).rows[0].email;

  // Conflicts show as the form is filled in: a member's email, a taken username.
  const check = await admin.get(`/api/admin/accounts/admin-check?email=${encodeURIComponent(memberEmail)}&username=testadmin&phone=09171239876`);
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.match(check.data.email.problem, /already used|record of member/);
  assert.match(check.data.username.problem, /taken/);
  assert.equal(check.data.phone.problem, null);
  assert.equal(check.data.smsAvailable, true);
  assert.ok(check.data.positions.includes('Treasurer'));
  assert.equal((await admin.post('/api/admin/accounts/admin-verifications', { channel: 'email', value: memberEmail })).status, 409);

  // The email: a code is sent, a wrong one is refused, the right one verifies it.
  const emailCode = await admin.post('/api/admin/accounts/admin-verifications', { channel: 'email', value: 'Treasurer.Officer@acifac.ph', name: 'Liza Ramos' });
  assert.equal(emailCode.status, 201, JSON.stringify(emailCode.data));
  const mail = await waitForMail((sent) => sent.to === 'treasurer.officer@acifac.ph' && /verify your email/i.test(sent.subject));
  assert.equal((await admin.post('/api/admin/accounts/admin-verifications', { channel: 'email', value: 'treasurer.officer@acifac.ph' })).status, 429, 'resend waits');
  const wrong = await admin.post(`/api/admin/accounts/admin-verifications/${emailCode.data.verificationId}/confirm`, { code: codeIn(mail.text) === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.equal((await admin.post(`/api/admin/accounts/admin-verifications/${emailCode.data.verificationId}/confirm`, { code: codeIn(mail.text) })).status, 200);

  const account = {
    fullName: 'Liza Ramos', position: 'Treasurer', username: 'liza.ramos', email: 'treasurer.officer@acifac.ph', phone: '0917 123 9876',
    password: 'Treasurer1!', confirmPassword: 'Treasurer1!', emailVerificationId: emailCode.data.verificationId,
  };
  // The mobile number must be verified too (text messages are set up here), and the position is required.
  assert.equal((await admin.post('/api/admin/accounts/admins', account)).status, 400);
  assert.equal((await admin.post('/api/admin/accounts/admins', { ...account, position: '' })).status, 400);
  const smsCode = await admin.post('/api/admin/accounts/admin-verifications', { channel: 'sms', value: '+63 917 123 9876' });
  assert.equal(smsCode.status, 201, JSON.stringify(smsCode.data));
  const text = sentTexts.findLast((sent) => sent.recipients?.includes('+639171239876'));
  assert.ok(text, JSON.stringify(sentTexts.at(-1)));
  assert.equal((await admin.post(`/api/admin/accounts/admin-verifications/${smsCode.data.verificationId}/confirm`, { code: codeIn(text.message) })).status, 200);

  const created = await admin.post('/api/admin/accounts/admins', { ...account, phoneVerificationId: smsCode.data.verificationId });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.role, 'ADMIN');
  await waitForMail((sent) => sent.to === 'treasurer.officer@acifac.ph' && /administrator account is ready/i.test(sent.subject) && !sent.text.includes('Treasurer1!'));
  // A verification is used once; the same email or number cannot make a second administrator.
  assert.equal((await admin.post('/api/admin/accounts/admins', { ...account, username: 'liza2', phoneVerificationId: smsCode.data.verificationId })).status, 409);
  assert.match((await admin.get('/api/admin/accounts/admin-check?phone=09171239876')).data.phone.problem, /Liza Ramos/);

  // Listed with the name, position and who made the account.
  const listed = (await admin.get('/api/admin/accounts')).data.accounts.find((row) => row.username === 'liza.ramos');
  assert.equal(listed.position, 'Treasurer');
  assert.equal(listed.full_name, 'Liza Ramos');
  assert.equal(listed.created_by_name, 'Coop Admin');
  assert.equal(listed.must_change_password, true);

  // The new administrator signs in with the username, the email or the mobile number.
  for (const identifier of ['liza.ramos', 'treasurer.officer@acifac.ph', '09171239876']) {
    const officer = new Client();
    const login = await officer.post('/api/auth/login', { usernameOrEmail: identifier, password: 'Treasurer1!' });
    assert.equal(login.status, 200, `${identifier}: ${JSON.stringify(login.data)}`);
    assert.equal(login.data.user.role, 'ADMIN');
  }

  // The audit log names each administrator with the position they held.
  const logs = (await admin.get('/api/admin/audit-logs?action=ADMIN_ACCOUNT_CREATED')).data.data;
  assert.equal(logs[0].user_position, 'Manager');
  assert.equal(logs[0].user_full_name, 'Coop Admin');
  assert.equal((await admin.get('/api/admin/audit-logs?search=Manager')).data.data.length > 0, true);
  // An administrator's own profile keeps a position, and their email stays their own.
  assert.equal((await admin.patch('/api/auth/profile', { position: '' })).status, 400);
  assert.equal((await admin.patch('/api/auth/profile', { email: 'treasurer.officer@acifac.ph' })).status, 409);

  // Another administrator can be switched off, and then cannot sign in.
  assert.equal((await admin.patch(`/api/admin/accounts/${created.data.user.id}/status`, { status: 'INACTIVE' })).status, 200);
  assert.notEqual((await new Client().post('/api/auth/login', { usernameOrEmail: 'liza.ramos', password: 'Treasurer1!' })).status, 200);
});

test('member activity log: own actions, office actions, filters, privacy', { skip }, async () => {
  const before = await member.get('/api/auth/me');
  assert.equal((await member.request('PATCH', '/api/auth/profile', { body: { phone: '09175550000' } })).status, 200);
  assert.equal((await member.patch('/api/auth/notification-preferences', { emailNotifications: true, loanReminders: false })).status, 200);
  await member.patch('/api/auth/notification-preferences', { emailNotifications: true, loanReminders: true });
  assert.equal((await new Client().post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'Wrong-password-1' })).status, 401);
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
  assert.equal(unknown.status, 404, 'an email on no account gets no code');
  const { code } = await nextResetCode('juan@example.com');
  assert.equal((await resetter.post('/api/auth/verify-reset-code', { email: 'juan@example.com', code })).status, 200);
  assert.equal((await resetter.post('/api/auth/reset-password', { newPassword: 'weak', confirmPassword: 'weak' })).status, 400);
  assert.equal((await resetter.post('/api/auth/reset-password', { newPassword: 'ResetPass1!', confirmPassword: 'ResetPass1!' })).status, 200);
  assert.equal((await member.post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'ResetPass1!' })).status, 200);

  const change = await member.post('/api/auth/change-password', { currentPassword: 'ResetPass1!', newPassword: 'ChangedPass1!', confirmPassword: 'ChangedPass1!' });
  assert.equal(change.status, 200);
  assert.equal((await member.get('/api/auth/me')).status, 401, 'change password ends the session');
  await member.post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'ChangedPass1!' });
  assert.equal((await member.get('/api/members/me')).status, 200);

  assert.equal((await admin.patch(`/api/admin/accounts/${state.memberUserId}/status`, { status: 'LOCKED' })).status, 200);
  const afterLock = await member.get('/api/members/me');
  assert.equal(afterLock.status, 401);
  assert.equal((await member.post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'ChangedPass1!' })).status, 403);
  await admin.patch(`/api/admin/accounts/${state.memberUserId}/status`, { status: 'ACTIVE' });
  assert.equal((await member.post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'ChangedPass1!' })).status, 200);
  const statusAudit = (await admin.get('/api/admin/audit-logs?action=ACCOUNT_STATUS_UPDATED')).data.data.filter((row) => row.entity_id === String(state.memberUserId));
  assert.equal(statusAudit.at(-1).old_values.account_status, 'ACTIVE');
  assert.equal(statusAudit.at(-1).new_values.account_status, 'LOCKED');

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
  assert.equal(first.data.message, 'Invalid email, mobile number or password.');
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

  // Only an account's own email gets a code; any other address is told it is not registered.
  const known = await browser.post('/api/auth/forgot-password', { email: 'ResetMe@acifac.local' });
  const unknown = await new Client('10.0.4.2').post('/api/auth/forgot-password', { email: 'ghost@acifac.local' });
  assert.equal(known.status, 200);
  assert.equal(known.data.message, 'A verification code was sent to r•••@acifac.local.');
  assert.equal(known.data.resendAvailableInSeconds, 60);
  assert.deepEqual([unknown.status, unknown.data.code], [404, 'RESET_ADDRESS_NOT_FOUND']);
  assert.equal(unknown.data.message, 'This email is not registered to any ACIFAC account. Use the email on your account or in your member information.');
  const { code: firstCode, mail } = await nextResetCode(email, seen);
  assert.match(firstCode, /^\d{6}$/);
  assert.match(mail.text, /Your verification code is:/);
  assert.match(mail.text, /This code expires in 10 minutes\./);
  assert.ok(!/https?:\/\//.test(mail.text) && !mail.html.includes('href'), 'no link, code only');
  assert.ok(!sentEmails.some((entry) => entry.to === 'ghost@acifac.local'), 'nothing is sent to unknown addresses');
  const rows = await pool.query('SELECT code_hash FROM password_reset_codes WHERE user_id = $1', [userId]);
  assert.ok(rows.rows[0].code_hash.startsWith('$2') && !rows.rows[0].code_hash.includes(firstCode), 'only a bcrypt hash is stored');

  // Resend cooldown for a code that was sent; a refused address has none to wait for.
  const tooSoon = await browser.post('/api/auth/forgot-password', { email });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.data.code, 'RESET_CODE_COOLDOWN');
  assert.ok(tooSoon.data.retryAfterSeconds > 0 && tooSoon.data.retryAfterSeconds <= 60);
  assert.equal((await new Client('10.0.4.2').post('/api/auth/forgot-password', { email: 'ghost@acifac.local' })).data.code, 'RESET_ADDRESS_NOT_FOUND');

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

test('password reset: hourly limits per address and per device', { skip }, async () => {
  await createLoginUser('flood', 'flood@acifac.local', 'FloodPass1!');
  const client = new Client('10.0.5.1');
  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await pool.query(`UPDATE password_reset_codes SET created_at = created_at - INTERVAL '61 seconds' WHERE ip_address = '10.0.5.1'`);
    statuses.push((await client.post('/api/auth/forgot-password', { email: 'flood@acifac.local' })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);

  // Refused addresses use up the device's allowance too (15 an hour), so the
  // form cannot be used to find out which addresses have accounts in bulk.
  const prober = new Client('10.0.5.2');
  const probes = [];
  for (let attempt = 0; attempt < 16; attempt += 1) probes.push((await prober.post('/api/auth/forgot-password', { email: `probe${attempt}@acifac.local` })).status);
  assert.deepEqual(probes, [...Array(15).fill(404), 429]);
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
  assert.equal((await new Client('10.0.7.3').post('/api/auth/login', { usernameOrEmail: 'rosa@example.com', password: 'RosaNew1!' })).status, 200, 'the member information\'s email signs in');
  assert.equal((await new Client('10.0.7.4').post('/api/auth/login', { usernameOrEmail: '0917 000 0900', password: 'RosaNew1!' })).status, 200, 'and so does its mobile number');
  assert.equal(sentTexts.length, textsBefore, 'a code asked for by email is only emailed');
});

test('password reset: by mobile number, texted to the number on the member record', { skip }, async () => {
  const phoneBrowser = new Client('10.0.8.1');
  assert.equal((await phoneBrowser.post('/api/auth/forgot-password', { phone: '0917-000' })).status, 400);

  // Any format of the number works; a number on no account is told so.
  const known = await phoneBrowser.post('/api/auth/forgot-password', { phone: '+63 917 000 0900' });
  const unknown = await new Client('10.0.8.2').post('/api/auth/forgot-password', { phone: '09170000999' });
  assert.equal(known.status, 200, JSON.stringify(known.data));
  assert.equal(known.data.message, 'A verification code was texted to 0917 ••• 0900.');
  assert.deepEqual([unknown.status, unknown.data.code], [404, 'RESET_ADDRESS_NOT_FOUND']);
  assert.match(unknown.data.message, /This mobile number is not registered to any ACIFAC account/);
  const text = await waitForText((entry) => entry.recipients[0] === '+639170000900');
  const code = /code: (\d{6})\./.exec(text.message)[1];
  assert.equal(text.message, `ACIFAC password reset code: ${code}. It expires in 10 minutes. Do not share it. If you did not ask for it, ignore this text.\n- ACIFAC Administrator`);
  assert.ok(!sentTexts.some((entry) => entry.recipients[0] === '+639170000999'), 'nothing is texted to unknown numbers');
  assert.ok(!sentEmails.some((mail) => mail.to === 'rosa@example.com' && mail.text.includes(code)), 'a code asked for by number is only texted');

  assert.equal((await phoneBrowser.post('/api/auth/verify-reset-code', { email: 'rosa@example.com', code })).status, 400, 'the code belongs to the number, not the email');
  assert.equal((await phoneBrowser.post('/api/auth/verify-reset-code', { phone: '09170000900', code })).status, 200);
  assert.equal((await phoneBrowser.post('/api/auth/reset-password', { newPassword: 'RosaText1!', confirmPassword: 'RosaText1!' })).status, 200);
  assert.equal((await new Client('10.0.8.3').post('/api/auth/login', { usernameOrEmail: 'rosa', password: 'RosaText1!' })).status, 200);

  // A number shared by two accounts resets and signs in to neither: it could not say which.
  const { hashPassword } = await import('../src/utils/password.js');
  const sibling = await pool.query(
    `INSERT INTO members (member_number, first_name, last_name, email, phone, address, membership_date, share_capital, status, farm_area_ha, date_of_birth)
     VALUES ('ACIFAC-2026-901', 'Ramon', 'Reyes', 'ramon@example.com', '0917 000 0900', 'Purok 9', '2026-01-15', 0, 'active', 1, '1988-01-01') RETURNING id`
  );
  await pool.query(`INSERT INTO users (member_id, username, email, password_hash, role, account_status) VALUES ($1, 'ramon', NULL, $2, 'MEMBER', 'ACTIVE')`, [sibling.rows[0].id, await hashPassword('RamonPass1!')]);
  await pool.query(`UPDATE password_reset_codes SET created_at = created_at - INTERVAL '61 seconds'`);
  const shared = await new Client('10.0.8.4').post('/api/auth/forgot-password', { phone: '09170000900' });
  const textsAfter = sentTexts.length;
  assert.deepEqual([shared.status, shared.data.code, shared.data.message], [409, 'RESET_ADDRESS_SHARED', 'This mobile number is on more than one account. Please use your email instead.']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sentTexts.length, textsAfter, 'nothing is texted to a shared number');
  assert.equal((await new Client('10.0.8.5').post('/api/auth/login', { usernameOrEmail: '09170000900', password: 'RosaText1!' })).status, 401);
  assert.equal((await new Client('10.0.8.6').post('/api/auth/login', { usernameOrEmail: 'ramon@example.com', password: 'RamonPass1!' })).status, 200, 'each still signs in with their email');

  // An account that is switched off gets no code either.
  await pool.query(`UPDATE users SET account_status = 'INACTIVE' WHERE username = 'ramon'`);
  const inactive = await new Client('10.0.8.7').post('/api/auth/forgot-password', { email: 'ramon@example.com' });
  assert.deepEqual([inactive.status, inactive.data.code], [403, 'RESET_ACCOUNT_INACTIVE']);
  await pool.query(`UPDATE users SET account_status = 'ACTIVE' WHERE username = 'ramon'`);
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

test('loans: restructuring after 80% paid deducts the balance from a new loan and stays in the credit history', { skip }, async () => {
  const { todayDateOnly } = await import('../src/utils/dates.js');
  const { refreshLoanStatuses } = await import('../src/services/loanService.js');
  const today = todayDateOnly();
  const plus = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const approved = plus(today, -100);
  // PHP 12,000 at 2.5% over 6 months, approved 100 days ago: three installments have fallen due.
  // A loan from before the single-payment policy, repaid monthly (those loans keep their schedules).
  const loanId = (await pool.query(
    `INSERT INTO loans (loan_number, member_id, member_name, loan_type, amount, balance, interest_rate, term, status, date_approved, due_date, monthly_payment, calculated_interest, total_repayment, repayment)
     VALUES ('L-RS-001', $1, 'Juan Dela Cruz', 'agricultural', 12000, 12300, 2.5, 6, 'active', $2, $3, 2050, 300, 12300, 'monthly') RETURNING id`,
    [state.memberId, approved, plus(approved, 182)]
  )).rows[0].id;
  await refreshLoanStatuses({ force: true });
  const before = (await admin.get(`/api/admin/loans/${loanId}`)).data;
  assert.equal(before.installments.length, 6);
  // The first installment is paid ten days late; the next two are left unpaid.
  const late = await admin.post(`/api/admin/loans/${loanId}/payments`, { amount: '2050', paymentDate: plus(before.installments[0].dueDate, 10) });
  assert.equal(late.status, 201, JSON.stringify(late.data));
  await refreshLoanStatuses({ force: true });
  const overdue = (await admin.get(`/api/admin/loans/${loanId}`)).data.loan;
  assert.deepEqual([overdue.status, overdue.balance, overdue.overdueInstallments], ['overdue', '10250.00', 2]);
  const juanBefore = (await admin.get('/api/admin/analytics?from=2000-01-01&to=2999-12-31')).data.memberAnalytics.find((row) => row.databaseId === state.memberId);
  const historyBefore = juanBefore.loanHistory.find((loan) => loan.id === loanId);
  assert.deepEqual([historyBefore.onTimePayments, historyBefore.latePayments, historyBefore.restructureCount], [0, 3, 0]);

  const url = `/api/admin/loans/${loanId}/restructure`;
  const valid = { amount: '50000', farmArea: '2', reason: 'Next cropping season' };
  // Admins only (the test member may already be signed out by the session tests).
  assert.ok([401, 403].includes((await member.post(url, valid)).status));
  assert.equal((await admin.post(url, { ...valid, amount: 'abc' })).status, 400);
  assert.equal((await admin.post(url, { ...valid, reason: '  ' })).status, 400);
  assert.equal((await admin.post(`/api/admin/loans/${state.loanId}/restructure`, valid)).status, 409, 'a fully paid loan has nothing to restructure');
  // Only PHP 2,050 of PHP 12,300 is paid: at least 80% (PHP 9,840) must be.
  const early = await admin.post(url, valid);
  assert.equal(early.status, 409);
  assert.match(early.data.message, /at least 80%.*PHP 7,790\.00 more/);

  // A part payment brings it to exactly 80%.
  const more = await admin.post(`/api/admin/loans/${loanId}/payments`, { amount: '7790', paymentDate: today });
  assert.equal(more.status, 201, JSON.stringify(more.data));
  assert.equal(more.data.payment.remainingBalance, '2460.00');
  assert.equal((await admin.post(url, { ...valid, amount: '150000' })).status, 400, 'at most PHP 50,000 a hectare');
  assert.equal((await admin.post(url, { ...valid, amount: '2000' })).status, 400, 'the new loan must cover what is still owed');

  const done = await admin.post(url, valid);
  assert.equal(done.status, 201, JSON.stringify(done.data));
  // PHP 2,460 still owed is deducted from the new PHP 50,000 loan: PHP 47,540 is released.
  assert.deepEqual(
    [done.data.restructuring.kind, done.data.restructuring.balance_carried, done.data.restructuring.amount_paid_before, done.data.restructuring.total_before, done.data.restructuring.net_proceeds],
    ['renewal', '2460.00', '9840.00', '12300.00', '47540.00']
  );
  const previous = done.data.previousLoan;
  assert.deepEqual([previous.status, previous.balance, previous.totalPaid, previous.restructureCount, previous.lastRestructuredOn], ['paid', '0.00', '12300.00', 1, today]);
  const created = done.data.loan;
  assert.deepEqual(
    [created.amount, created.totalAmount, created.totalInterest, created.balance, created.term, created.repayment, created.renewedFromLoan, created.renewalDeduction, created.netProceeds, created.restructureCount],
    ['50000.00', '51250.00', '1250.00', '51250.00', 6, 'single', 'L-RS-001', '2460.00', '47540.00', 0]
  );
  const dueDays = (Date.parse(created.dueDate) - Date.parse(today)) / 86400000;
  assert.ok(dueDays >= 181 && dueDays <= 186, String(dueDays));
  const detail = (await admin.get(`/api/admin/loans/${loanId}`)).data;
  assert.deepEqual(detail.restructurings.map((row) => [row.kind, row.reason, row.newLoanNumber, row.newLoanAmount, row.recordedBy]),
    [['renewal', 'Next cropping season', created.id, '50000.00', 'testadmin']]);
  // Payments are listed newest first: the deduction is the last one.
  assert.deepEqual([detail.payments[0].amount, detail.payments[0].remainingBalance], ['2460.00', '0.00']);
  assert.ok(detail.installments.every((row) => row.status === 'paid' || row.status === 'paid_late'));
  assert.equal((await admin.post(url, valid)).status, 409, 'the old loan is closed');

  // The member is told; the credit history keeps the late installments and counts the restructured loan.
  const told = (await pool.query(`SELECT message FROM notifications WHERE user_id = $1 AND type = 'loan_restructured'`, [state.memberUserId])).rows;
  assert.ok(told.length === 1 && told[0].message.includes('L-RS-001') && told[0].message.includes(created.id) && told[0].message.includes('PHP 47,540.00'), JSON.stringify(told));
  const analytics = (await admin.get('/api/admin/analytics?from=2000-01-01&to=2999-12-31')).data;
  const juan = analytics.memberAnalytics.find((row) => row.databaseId === state.memberId);
  const history = juan.loanHistory.find((row) => row.id === loanId);
  assert.deepEqual([history.latePayments, history.restructureCount], [3, 1]);
  assert.deepEqual([juan.restructuredLoans, juan.restructurings], [juanBefore.restructuredLoans + 1, juanBefore.restructurings + 1]);
  assert.equal(juan.latePayments, juanBefore.latePayments, 'restructuring does not erase late payments');
  assert.equal(juan.overdueInstallments, juanBefore.overdueInstallments - 2);
  assert.ok(analytics.methodology.restructuredLoans);
  // Debt-to-capital was removed from the analytics.
  assert.ok(!('debtToCapitalRatio' in juan) && !('exposure' in juan) && !('savings' in juan) && !analytics.methodology.debtToCapital);
  const audit = (await pool.query(`SELECT new_values FROM audit_logs WHERE action = 'LOAN_RESTRUCTURED' AND entity_id = $1`, [String(loanId)])).rows;
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].new_values.reason, audit[0].new_values.net_proceeds], ['Next cropping season', '47540.00']);

  // Clicking the member in the credit history: a suggestion from how they
  // repaid, with the same figures as the table (rule-based here: no AI key).
  const advice = await admin.post(`/api/admin/analytics/members/${state.memberId}/credit-advice`);
  assert.equal(advice.status, 200, JSON.stringify(advice.data));
  assert.equal(advice.data.source, 'rules');
  assert.ok(['lend', 'caution', 'do_not_lend', 'no_history'].includes(advice.data.verdict));
  assert.ok(advice.data.suggestion.length > 20);
  assert.deepEqual(
    [advice.data.facts.installments.due, advice.data.facts.installments.onTime, advice.data.facts.installments.late, advice.data.facts.installments.overdueNow, advice.data.facts.loans.restructured],
    [juan.installmentsDue, juan.onTimePayments, juan.latePayments, juan.overdueInstallments, juan.restructuredLoans]
  );
  assert.notEqual(advice.data.verdict, 'lend', 'late installments never get a plain "can lend"');
  assert.equal((await admin.post('/api/admin/analytics/members/999999/credit-advice')).status, 404);
  // Admins only (the member's session has ended by this test, hence 401 or 403).
  assert.ok([401, 403].includes((await member.post(`/api/admin/analytics/members/${state.memberId}/credit-advice`)).status));

  // A single-payment loan, past due, is paid in parts; once 80% is paid it is
  // restructured into a new loan (at most PHP 50,000 a hectare).
  const singleId = (await pool.query(
    `INSERT INTO loans (loan_number, member_id, member_name, loan_type, amount, balance, interest_rate, term, status, date_approved, due_date, monthly_payment, calculated_interest, total_repayment, repayment)
     VALUES ('L-RS-002', $1, 'Juan Dela Cruz', 'agricultural', 10000, 10250, 2.5, 6, 'active', $2, $3, 10250, 250, 10250, 'single') RETURNING id`,
    [state.memberId, plus(today, -200), plus(today, -17)]
  )).rows[0].id;
  await refreshLoanStatuses({ force: true });
  assert.equal((await admin.get(`/api/admin/loans/${singleId}`)).data.loan.status, 'overdue');
  const half = await admin.post(`/api/admin/loans/${singleId}/payments`, { amount: '5000', paymentDate: today });
  assert.equal(half.status, 201, JSON.stringify(half.data));
  assert.equal(half.data.payment.remainingBalance, '5250.00');
  const singleUrl = `/api/admin/loans/${singleId}/restructure`;
  assert.equal((await admin.post(singleUrl, { amount: '20000', farmArea: '1', reason: 'Late harvest' })).status, 409, 'under 80% paid');
  assert.equal((await admin.post(`/api/admin/loans/${singleId}/payments`, { amount: '3200', paymentDate: today })).status, 201);
  assert.equal((await admin.post(singleUrl, { amount: '20000', farmArea: '0.3', reason: 'Late harvest' })).status, 400, '0.3 ha allows PHP 15,000');
  const single = await admin.post(singleUrl, { amount: '20000', farmArea: '1', reason: 'Late harvest' });
  assert.equal(single.status, 201, JSON.stringify(single.data));
  assert.deepEqual([single.data.restructuring.balance_carried, single.data.restructuring.net_proceeds, single.data.restructuring.overdue_installments], ['2050.00', '17950.00', 1]);
  assert.deepEqual([single.data.previousLoan.status, single.data.loan.totalAmount, single.data.loan.farmArea], ['paid', '20500.00', '1.00']);

  // The member's loan summary lists both restructured loans, the new ones, and every payment.
  const loanHistory = (await admin.get(`/api/admin/members/${state.memberId}/loan-history`)).data;
  const numbers = loanHistory.loans.map((row) => row.id);
  assert.ok(['L-RS-001', 'L-RS-002', created.id, single.data.loan.id].every((number) => numbers.includes(number)), JSON.stringify(numbers));
  assert.equal(loanHistory.summary.loans, loanHistory.loans.length);
  assert.equal(loanHistory.summary.restructurings, (await pool.query('SELECT COUNT(*)::int AS count FROM loan_restructurings r JOIN loans l ON l.id = r.loan_id WHERE l.member_id = $1', [state.memberId])).rows[0].count);
  assert.ok(loanHistory.payments.some((row) => row.loanNumber === 'L-RS-002' && row.amount === '2050.00'), 'the deduction is in the payment history');
  assert.equal((await admin.get('/api/admin/members/999999/loan-history')).status, 404);
});
