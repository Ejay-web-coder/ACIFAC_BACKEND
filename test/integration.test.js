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
let pool;
const sentEmails = [];
const ORIGIN = 'http://localhost:5173';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

class Client {
  constructor() { this.cookie = ''; }
  async request(method, url, { body, form, headers = {}, raw = false } = {}) {
    const init = { method, headers: { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest', ...headers } };
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (form) init.body = form;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const response = await fetch(`${baseUrl}${url}`, init);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const token = /session_token=([^;]*)/.exec(setCookie)?.[1];
      this.cookie = token ? `session_token=${token}` : '';
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

function memberForm(overrides = {}, file = PNG) {
  const form = new FormData();
  const fields = {
    first_name: 'Juan', last_name: 'Dela Cruz', email: 'juan@example.com', phone: '09171234567', address: 'Purok 1, Amnay',
    membership_date: '2026-01-15', share_capital: '1000', farm_area_ha: '2', date_of_birth: '1980-05-20', status: 'active', ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append('idDocument', new Blob([file], { type: 'image/png' }), 'id.png');
  return form;
}

const admin = new Client();
const member = new Client();
const state = {};

before(async () => {
  if (skip) return;
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'acifac-docs-'));
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, DATABASE_SSL: 'disable', NODE_ENV: 'test', CORS_ORIGIN: ORIGIN, FRONTEND_URL: ORIGIN,
    MEMBER_DOCUMENT_DIR: docs, OCR_AI_API_KEY: 'test-key', API_RATE_LIMIT_PER_MINUTE: '100000', EMAIL_FROM: 'test@acifac.local',
  });
  delete process.env.GEMINI_API_KEY;
  delete process.env.SUPABASE_URL;

  stubServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (stubMode === 'fail') { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ documentType: 'Payment Receipt', confidence: 92, ocrText: 'Receipt 123', extractedData: { 'Member Name': 'Juan Dela Cruz', 'Payment Amount': '500.00' } }) } }] }));
    });
  }).listen(0);
  process.env.OCR_AI_URL = `http://127.0.0.1:${stubServer.address().port}/v1/chat/completions`;

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
  const created = await admin.request('POST', '/api/members', { form: memberForm() });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  state.memberId = created.data.data.id;
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

  const detail = await admin.get(`/api/members/${state.memberId}`);
  const updated = await admin.put(`/api/members/${state.memberId}`, { ...detail.data.data, phone: '09179999999', membership_date: detail.data.data.membership_date });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(updated.data.data.phone, '09179999999');
  assert.equal(updated.data.data.share_capital, 1000);

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
  const relogin = await member.post('/api/auth/login', { usernameOrEmail: 'juan@example.com', password: 'MemberPass1!' });
  assert.equal(relogin.status, 200);
  assert.equal(relogin.data.mustChangePassword, false);
});

test('authorization: members cannot read other members or admin data', { skip }, async () => {
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

  const tooMuch = await member.post('/api/members/me/loan-requests', { loanType: 'agricultural', amount: '150000', term: 12, purpose: 'Seeds', farmArea: '2' });
  assert.equal(tooMuch.status, 400);
  const applied = await member.post('/api/members/me/loan-requests', { loanType: 'agricultural', amount: '50000', term: 12, purpose: 'Rice seeds and fertilizer', farmArea: '2', totalRepayment: '1' });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal(applied.data.request.totalRepayment, '51250.00', 'client-sent totals are ignored');
  const twice = await member.post('/api/members/me/loan-requests', { loanType: 'agricultural', amount: '1000', term: 12, purpose: 'x', farmArea: '2' });
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

  const declined = await member.post('/api/members/me/loan-requests', { loanType: 'emergency', amount: '1000', term: 3, purpose: 'Repair', farmArea: '2' });
  const decline = await admin.patch(`/api/admin/loan-requests/${declined.data.request.id}`, { status: 'declined', reason: 'Incomplete documents' });
  assert.equal(decline.status, 200);
  const memberNotes = await member.get('/api/notifications');
  assert.ok(memberNotes.data.data.some((n) => n.type === 'loan_declined' && /Incomplete documents/.test(n.message)));
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
  assert.equal(dashboard.data.stats.totalMembers, 2);
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

test('sessions: forgot password, change password, deactivation, logout', { skip }, async () => {
  const forgot = await new Client().post('/api/auth/forgot-password', { usernameOrEmail: 'juan' });
  const token = forgot.headers.get('x-test-reset-token');
  assert.ok(token);
  const unknown = await new Client().post('/api/auth/forgot-password', { usernameOrEmail: 'nobody' });
  assert.equal(unknown.data.message, forgot.data.message, 'no account enumeration');
  assert.equal((await new Client().post('/api/auth/reset-password', { token, newPassword: 'weak', confirmPassword: 'weak' })).status, 400);
  assert.equal((await new Client().post('/api/auth/reset-password', { token, newPassword: 'ResetPass1!', confirmPassword: 'ResetPass1!' })).status, 200);
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
