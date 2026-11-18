// Load test for one module of the ACIFAC backend at a time (Grafana k6).
//
//   k6 run -e MODULE=members loadtest/modules.k6.js                     smoke: 2 users, 30 s
//   k6 run -e MODULE=members -e TEST_TYPE=load loadtest/modules.k6.js   30 users for 2 minutes
//
// loadtest/run-modules.ps1 runs every module in turn and builds one results
// table. acifac.k6.js is the other test: all modules at once, the way members
// and the office use the system together.
//
// Each virtual user signs in once (as the role the module needs), then keeps
// going through the module's endpoints one by one with 1-2 s between them,
// like someone clicking through its pages. Only GET requests, except in "auth"
// (login, check the session, logout). The summary has one line per endpoint.
//
// Options (-e NAME=value):
//   MODULE        one of the MODULES below (required)
//   TEST_TYPE     smoke | load | stress | spike   (default smoke)
//   VUS           users for TEST_TYPE=load        (default 30)
//   BASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD, MEMBER_PASSWORD, MEMBER_COUNT, ALLOW_REMOTE
//                 as in acifac.k6.js
//   VENDOR_USERNAME / VENDOR_PASSWORD  (default loadtest-vendor / Vendor@12345; the
//                 admin creates this Kadiwa vendor account in setup when it is missing)

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const BASE_URL = String(__ENV.BASE_URL || 'http://localhost:4001').replace(/\/$/, '');
const MODULE = __ENV.MODULE || '';
const TEST_TYPE = __ENV.TEST_TYPE || 'smoke';
const VUS = Number(__ENV.VUS || 30);
const ADMIN_USERNAME = __ENV.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'Admin@12345';
const MEMBER_PASSWORD = __ENV.MEMBER_PASSWORD || 'Member@12345';
const MEMBER_COUNT = Number(__ENV.MEMBER_COUNT || 100);
const VENDOR_USERNAME = __ENV.VENDOR_USERNAME || 'loadtest-vendor';
const VENDOR_PASSWORD = __ENV.VENDOR_PASSWORD || 'Vendor@12345';

const host = BASE_URL.replace(/^https?:\/\//, '').split(/[/:]/)[0];
if (!['localhost', '127.0.0.1'].includes(host) && __ENV.ALLOW_REMOTE !== 'true') {
  throw new Error(`BASE_URL ${BASE_URL} is not this computer. Load-test the local backend (loadtest/README.md), or pass -e ALLOW_REMOTE=true if you really mean it.`);
}

// Dates in the cooperative's time zone (UTC+8), as YYYY-MM-DD.
const day = (offsetDays) => new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
const YEAR = day(0).slice(0, 4);
const LAST_30_DAYS = `from=${day(-29)}&to=${day(0)}`;  // machinery availability allows at most 93 days
const LAST_90_DAYS = `from=${day(-89)}&to=${day(0)}`;
const BANDS = ['below1k', 'from1kTo5k', 'from5kTo15k', 'from15kTo20k', 'maximum'];
const SEARCHES = ['santos', 'cruz', 'maria', 'jose', 'reyes', 'dizon'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const memberPage = () => 1 + Math.floor(Math.random() * Math.max(1, Math.ceil(MEMBER_COUNT / 20)));
// An endpoint that needs a record: skipped when the database has none.
const withId = (list, build) => (list && list.length ? build(pick(list)) : null);

// [name shown in the results, path (gets the record ids found in setup)].
const MODULES = {
  auth: { label: 'Login and session', role: 'member', endpoints: [] }, // see authRound()
  dashboard: {
    label: 'Admin dashboard', role: 'admin', endpoints: [
      ['GET /api/admin/dashboard', () => '/api/admin/dashboard'],
      ['GET /api/admin/dashboard/share-capital/:band', () => `/api/admin/dashboard/share-capital/${pick(BANDS)}`],
    ],
  },
  members: {
    label: 'Members', role: 'admin', endpoints: [
      ['GET /api/members?page=N', () => `/api/members?page=${memberPage()}&limit=20`],
      ['GET /api/members?search=X', () => `/api/members?search=${pick(SEARCHES)}&limit=20`],
      ['GET /api/members/statistics', () => '/api/members/statistics'],
      ['GET /api/members/archived', () => '/api/members/archived?page=1&limit=20'],
      ['GET /api/admin/members/available', () => '/api/admin/members/available'],
      ['GET /api/members/:id', (ids) => withId(ids.members, (id) => `/api/members/${id}`)],
      ['GET /api/members/:id/dividend', (ids) => withId(ids.members, (id) => `/api/members/${id}/dividend`)],
    ],
  },
  savings: {
    label: 'Savings', role: 'admin', endpoints: [
      ['GET /api/members/savings', () => '/api/members/savings'],
      ['GET /api/members/savings/members', () => '/api/members/savings/members'],
      ['GET /api/members/:id/savings', (ids) => withId(ids.members, (id) => `/api/members/${id}/savings`)],
    ],
  },
  loans: {
    label: 'Loans', role: 'admin', endpoints: [
      ['GET /api/admin/loans', () => '/api/admin/loans'],
      ['GET /api/admin/loans/:id', (ids) => withId(ids.loans, (id) => `/api/admin/loans/${id}`)],
      ['GET /api/admin/loan-payments', () => '/api/admin/loan-payments'],
      ['GET /api/admin/loan-requests', () => '/api/admin/loan-requests'],
      ['GET /api/admin/members/:id/loan-history', (ids) => withId(ids.loanMembers, (id) => `/api/admin/members/${id}/loan-history`)],
      ['GET /api/loans/policy', () => '/api/loans/policy'],
      ['GET /api/loans/farm-inputs', () => '/api/loans/farm-inputs'],
    ],
  },
  machinery: {
    label: 'Machinery', role: 'admin', endpoints: [
      ['GET /api/machinery', () => '/api/machinery'],
      ['GET /api/machinery/catalog', () => '/api/machinery/catalog'],
      ['GET /api/machinery/availability', () => `/api/machinery/availability?${LAST_30_DAYS}`],
      ['GET /api/machinery/services', () => '/api/machinery/services'],
      ['GET /api/machinery/services/:id', (ids) => withId(ids.services, (id) => `/api/machinery/services/${id}`)],
      ['GET /api/machinery/:id/rates', (ids) => withId(ids.machinery, (id) => `/api/machinery/${encodeURIComponent(id)}/rates`)],
      ['GET /api/machinery/expenses', () => '/api/machinery/expenses'],
      ['GET /api/machinery/period-balances', () => `/api/machinery/period-balances?croppingPeriod=${pick(['1st', '2nd', '3rd'])}&year=${YEAR}`],
      ['GET /api/machinery/reports/philmech', () => `/api/machinery/reports/philmech?croppingPeriod=${pick(['1st', '2nd', '3rd'])}&year=${YEAR}`],
      ['GET /api/machinery/reports/philmech/form', () => `/api/machinery/reports/philmech/form?croppingPeriod=${pick(['1st', '2nd', '3rd'])}&year=${YEAR}`],
    ],
  },
  kadiwa: {
    label: 'Kadiwa store', role: 'admin', endpoints: [
      ['GET /api/kadiwa', () => '/api/kadiwa'],
      ['GET /api/kadiwa/branches', () => '/api/kadiwa/branches'],
      ['GET /api/kadiwa/sales', () => `/api/kadiwa/sales?${LAST_90_DAYS}`],
      ['GET /api/kadiwa/analytics', () => `/api/kadiwa/analytics?${LAST_90_DAYS}`],
      ['GET /api/kadiwa/members?search=X', () => `/api/kadiwa/members?search=${pick(SEARCHES)}`],
    ],
  },
  vendor: {
    label: 'Kadiwa vendor portal', role: 'vendor', endpoints: [
      ['GET /api/vendor/kadiwa', () => '/api/vendor/kadiwa'],
      ['GET /api/vendor/kadiwa/sales', () => `/api/vendor/kadiwa/sales?${LAST_90_DAYS}`],
      ['GET /api/vendor/kadiwa/analytics', () => `/api/vendor/kadiwa/analytics?${LAST_90_DAYS}`],
      ['GET /api/vendor/activity', () => '/api/vendor/activity'],
    ],
  },
  attendance: {
    label: 'Attendance', role: 'admin', endpoints: [
      ['GET /api/attendance/dashboard', () => '/api/attendance/dashboard'],
      ['GET /api/attendance/activities', () => '/api/attendance/activities'],
      ['GET /api/attendance/activities/:id', (ids) => withId(ids.activities, (id) => `/api/attendance/activities/${id}`)],
      ['GET /api/attendance/activities/:id/members', (ids) => withId(ids.activities, (id) => `/api/attendance/activities/${id}/members`)],
      ['GET /api/attendance/activities/:id/history', (ids) => withId(ids.activities, (id) => `/api/attendance/activities/${id}/history`)],
      ['GET /api/attendance/records', () => '/api/attendance/records'],
      ['GET /api/attendance/reports/participation', () => '/api/attendance/reports/participation'],
      ['GET /api/attendance/members/:id', (ids) => withId(ids.members, (id) => `/api/attendance/members/${id}`)],
    ],
  },
  analytics: {
    label: 'Analytics', role: 'admin', endpoints: [
      ['GET /api/admin/analytics', () => '/api/admin/analytics'],
      ['GET /api/admin/analytics/revenue', () => '/api/admin/analytics/revenue'],
      ['GET /api/admin/analytics/kadiwa-products', () => '/api/admin/analytics/kadiwa-products'],
      ['GET /api/admin/analytics/machinery', () => '/api/admin/analytics/machinery'],
    ],
  },
  ocr: {
    // Scanning itself calls the AI service, so only the lists are load-tested.
    label: 'OCR scanner', role: 'admin', endpoints: [
      ['GET /api/ocr', () => '/api/ocr'],
      ['GET /api/ocr/forms', () => '/api/ocr/forms'],
    ],
  },
  users: {
    label: 'Manage users and audit log', role: 'admin', endpoints: [
      ['GET /api/admin/accounts', () => '/api/admin/accounts'],
      ['GET /api/admin/accounts/:id', (ids) => withId(ids.accounts, (id) => `/api/admin/accounts/${id}`)],
      ['GET /api/admin/audit-logs', () => '/api/admin/audit-logs'],
    ],
  },
  communication: {
    label: 'Notifications, announcements and documents', role: 'member', endpoints: [
      ['GET /api/notifications', () => '/api/notifications'],
      ['GET /api/announcements', () => '/api/announcements'],
      ['GET /api/legal-documents', () => '/api/legal-documents'],
      ['GET /api/events/changes', () => '/api/events/changes'],
    ],
  },
  about: {
    label: 'About, org chart and policies', role: 'member', endpoints: [
      ['GET /api/about', () => '/api/about'],
      ['GET /api/org-chart', () => '/api/org-chart'],
      ['GET /api/policies', () => '/api/policies'],
    ],
  },
  'member-portal': {
    label: 'Member portal', role: 'member', endpoints: [
      ['GET /api/members/me', () => '/api/members/me'],
      ['GET /api/members/me/loan-history', () => '/api/members/me/loan-history'],
      ['GET /api/members/me/activity', () => '/api/members/me/activity'],
      ['GET /api/members/me/attendance', () => '/api/members/me/attendance'],
      ['GET /api/machinery/catalog', () => '/api/machinery/catalog'],
    ],
  },
};

const mod = MODULES[MODULE];
if (!mod) throw new Error(`Choose a module with -e MODULE=..., one of: ${Object.keys(MODULES).join(', ')}`);
const AUTH_ENDPOINTS = ['POST /api/auth/login', 'GET /api/auth/me', 'GET /api/auth/session', 'POST /api/auth/logout'];
const endpointNames = MODULE === 'auth' ? AUTH_ENDPOINTS : mod.endpoints.map(([name]) => name);

const STAGES = {
  smoke: [{ duration: '5s', target: 2 }, { duration: '25s', target: 2 }],
  load: [{ duration: '30s', target: VUS }, { duration: '2m', target: VUS }, { duration: '30s', target: 0 }],
  stress: [
    { duration: '30s', target: 50 }, { duration: '1m', target: 50 },
    { duration: '30s', target: 100 }, { duration: '1m', target: 100 },
    { duration: '30s', target: 200 }, { duration: '1m', target: 200 },
    { duration: '30s', target: 0 },
  ],
  spike: [
    { duration: '20s', target: 5 }, { duration: '10s', target: 100 }, { duration: '1m', target: 100 },
    { duration: '10s', target: 5 }, { duration: '30s', target: 5 }, { duration: '10s', target: 0 },
  ],
};
if (!STAGES[TEST_TYPE]) throw new Error(`TEST_TYPE must be one of: ${Object.keys(STAGES).join(', ')}`);

// One response-time and one error-rate line per endpoint in the summary.
const thresholds = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
};
for (const name of endpointNames) {
  thresholds[`http_req_duration{name:${name}}`] = [name === 'POST /api/auth/login' ? 'p(95)<3000' : 'p(95)<1000'];
  thresholds[`http_req_failed{name:${name}}`] = ['rate<0.01'];
}

export const options = {
  noCookiesReset: true, // each user keeps its session cookie between rounds, like a browser
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    [MODULE]: { executor: 'ramping-vus', startVUs: 0, stages: STAGES[TEST_TYPE], gracefulRampDown: '30s' },
  },
  thresholds,
};

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

// Every virtual user comes from its own address, as real members do on their own
// phones. The backend counts sign-in attempts and requests per address, and reads
// the address from X-Forwarded-For (it sits behind one proxy on Vercel). If all
// users shared 127.0.0.1, the sign-in flood guard (10 sign-ins in progress per
// address) would refuse them, and keep refusing that address for 15 minutes.
const userAddress = () => {
  const n = exec.vu.idInTest;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};
const userHeaders = (headers = {}) => ({ 'X-Forwarded-For': userAddress(), ...headers });
const SETUP_HEADERS = { 'X-Forwarded-For': '10.255.255.254' };
const SETUP = { tags: { name: 'setup' }, headers: SETUP_HEADERS };

function setupLogin(username, password) {
  const res = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ usernameOrEmail: username, password }), { ...SETUP, headers: { ...JSON_HEADERS, ...SETUP_HEADERS } });
  if (res.status === 429) {
    throw new Error('Setup: the backend is refusing sign-ins for now (429: too many attempts from one address). '
      + 'Restart it in terminal 1 (Ctrl+C, then "node loadtest/local.mjs server") or wait 15 minutes.');
  }
  if (res.status !== 200) throw new Error(`Setup: sign-in as ${username} failed (${res.status}): ${res.body}`);
}

// Runs once before the test: checks the backend, finds records for the detail
// endpoints and, for the vendor module, makes sure the vendor account exists.
export function setup() {
  const probe = http.get(`${BASE_URL}/api/auth/session`, { ...SETUP, responseCallback: http.expectedStatuses(401) });
  if (probe.status === 0) throw new Error(`No backend at ${BASE_URL}: start it with "node loadtest/local.mjs server".`);
  const limit = Number(Object.entries(probe.headers).find(([key]) => key.toLowerCase() === 'ratelimit-limit')?.[1]);
  if (limit && limit <= 600 && __ENV.ALLOW_REMOTE !== 'true') {
    throw new Error(`${BASE_URL} allows ${limit} requests a minute per address, so it is not the load-test backend `
      + '(the one on port 4000 uses the live database). Start "node loadtest/local.mjs server" and use port 4001.');
  }

  setupLogin(ADMIN_USERNAME, ADMIN_PASSWORD);
  const list = (path, pickIds) => {
    const res = http.get(`${BASE_URL}${path}`, SETUP);
    if (res.status !== 200) throw new Error(`Setup: ${path} answered ${res.status}: ${String(res.body).slice(0, 200)}`);
    return pickIds(res.json()).filter((id) => id !== null && id !== undefined).slice(0, 50);
  };
  const loans = http.get(`${BASE_URL}/api/admin/loans`, SETUP).json();
  const ids = {
    members: list('/api/members?page=1&limit=50', (body) => body.data.map((m) => m.id)),
    loans: (loans.loans || []).map((l) => l.databaseId).slice(0, 50),
    loanMembers: [...new Set((loans.loans || []).map((l) => l.memberDatabaseId))].slice(0, 50),
    activities: list('/api/attendance/activities', (body) => body.data.map((a) => a.id)),
    services: list('/api/machinery/services', (body) => body.services.map((s) => s.id)),
    machinery: list('/api/machinery/catalog', (body) => body.machinery.map((m) => m.id)),
    accounts: list('/api/admin/accounts', (body) => body.accounts.map((a) => a.user_id)),
  };

  if (mod.role === 'vendor') {
    // 201 the first time; 400 "username already taken" on later runs.
    http.post(`${BASE_URL}/api/admin/accounts/vendors`, JSON.stringify({
      fullName: 'Load Test Vendor', username: VENDOR_USERNAME, password: VENDOR_PASSWORD, confirmPassword: VENDOR_PASSWORD,
    }), { ...SETUP, headers: { ...JSON_HEADERS, ...SETUP_HEADERS }, responseCallback: http.expectedStatuses(201, 400, 409) });
  }
  // Also saved in --summary-export, for module-table.mjs and show-summary.mjs.
  return { ...ids, module: MODULE, label: mod.label, testType: TEST_TYPE, stages: STAGES[TEST_TYPE], endpoints: endpointNames };
}

let signedIn = false;
let reported = 0;

function reportFailure(name, res) {
  if (res.status === 200 || reported >= 5) return;
  reported += 1;
  const reason = res.status ? `HTTP ${res.status}` : `no answer (${res.error})`;
  console.warn(`VU ${exec.vu.idInTest}: ${name} -> ${reason} ${String(res.body || '').slice(0, 200)}`);
}

function think() {
  sleep(1 + Math.random());
}

function credentials() {
  if (mod.role === 'admin') return [ADMIN_USERNAME, ADMIN_PASSWORD];
  if (mod.role === 'vendor') return [VENDOR_USERNAME, VENDOR_PASSWORD];
  return [`member${String(((exec.vu.idInTest - 1) % MEMBER_COUNT) + 1).padStart(3, '0')}`, MEMBER_PASSWORD];
}

function signIn(tags) {
  const [username, password] = credentials();
  const res = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ usernameOrEmail: username, password }), { headers: userHeaders(JSON_HEADERS), tags });
  if (check(res, { 'signed in': (r) => r.status === 200 })) return true;
  reportFailure(`POST /api/auth/login as ${username}`, res);
  // Wrong password or inactive account: every user would fail the same way and
  // add to the lockout, so stop. A 429 (too many attempts) is a result: it is
  // counted as an error and this user waits before trying again.
  if ([401, 403].includes(res.status)) exec.test.abort(`Sign-in as ${username} failed (${res.status}): ${res.body}`);
  sleep(res.status === 429 ? 10 : 5);
  return false;
}

function get(name, path) {
  const res = http.get(`${BASE_URL}${path}`, { tags: { name }, headers: userHeaders() });
  check(res, { 'status 200': (r) => r.status === 200 });
  reportFailure(name, res);
  if (res.status === 401) signedIn = false;
  return res;
}

// The auth module: a full sign-in, two session checks and a sign-out every round.
function authRound() {
  if (!signIn({ name: 'POST /api/auth/login' })) return;
  think();
  get('GET /api/auth/me', '/api/auth/me');
  think();
  get('GET /api/auth/session', '/api/auth/session');
  think();
  const res = http.post(`${BASE_URL}/api/auth/logout`, null, { headers: userHeaders({ 'X-Requested-With': 'XMLHttpRequest' }), tags: { name: 'POST /api/auth/logout' } });
  check(res, { 'status 200': (r) => r.status === 200 });
  reportFailure('POST /api/auth/logout', res);
  think();
}

export default function (ids) {
  if (MODULE === 'auth') return authRound();
  if (!signedIn) {
    signedIn = signIn({ name: 'sign-in' });
    if (!signedIn) return;
  }
  for (const [name, path] of mod.endpoints) {
    const url = path(ids);
    if (!url) continue;
    get(name, url);
    if (!signedIn) return;
    think();
  }
}
