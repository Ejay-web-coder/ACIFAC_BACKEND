// Load test for the ACIFAC backend with Grafana k6.
//
//   k6 run loadtest/acifac.k6.js                       smoke:  2 users, 30 s (does it work at all?)
//   k6 run -e TEST_TYPE=load   loadtest/acifac.k6.js   load:   50 users for 3 minutes (a busy day)
//   k6 run -e TEST_TYPE=load -e VUS=100 loadtest/acifac.k6.js   load with 100 users
//   k6 run -e TEST_TYPE=stress loadtest/acifac.k6.js   stress: 50 -> 100 -> 200 users (where does it break?)
//   k6 run -e TEST_TYPE=spike  loadtest/acifac.k6.js   spike:  10 -> 150 users at once (everyone opens it after a meeting)
//
// Each virtual user signs in once, then keeps browsing like a real person:
// it opens a page (the page's requests go out together, as a browser sends
// them), reads it for a few seconds while the page asks for changes every
// 3 seconds (GET /api/events/changes, as the app does on Vercel), then opens
// the next page. One user in ADMIN_EVERY is an administrator; the rest are
// members. Everything is read-only, so a run adds no records (only sessions
// and sign-in audit entries).
//
// It expects the local backend from loadtest/local.mjs (see loadtest/README.md).
//
// Options (-e NAME=value):
//   BASE_URL         backend address               (default http://localhost:4001)
//   TEST_TYPE        smoke | load | stress | spike (default smoke)
//   VUS              users for TEST_TYPE=load      (default 50)
//   ADMIN_USERNAME / ADMIN_PASSWORD               (default admin / Admin@12345, from the seeder)
//   MEMBER_PASSWORD                               (default Member@12345, from the seeder)
//   MEMBER_COUNT     member001 ... memberNNN exist (default 100, the seeder's sample members)
//   ADMIN_EVERY      1 user in N is an admin       (default 10)
//   POLL             false: no change checks while reading a page
//   ALLOW_REMOTE     true: allow a BASE_URL that is not this computer

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import exec from 'k6/execution';

const BASE_URL = String(__ENV.BASE_URL || 'http://localhost:4001').replace(/\/$/, '');
const TEST_TYPE = __ENV.TEST_TYPE || 'smoke';
const VUS = Number(__ENV.VUS || 50);
const ADMIN_USERNAME = __ENV.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'Admin@12345';
const MEMBER_PASSWORD = __ENV.MEMBER_PASSWORD || 'Member@12345';
const MEMBER_COUNT = Number(__ENV.MEMBER_COUNT || 100);
const ADMIN_EVERY = Number(__ENV.ADMIN_EVERY || 10);
const POLL = __ENV.POLL !== 'false';
const POLL_SECONDS = 3;

// The live system runs on Vercel and Supabase: a load test there uses up the
// cooperative's quotas, slows the app for real members and fills the live
// audit log. Its per-address rate limit would also turn most requests into 429.
const host = BASE_URL.replace(/^https?:\/\//, '').split(/[/:]/)[0];
if (!['localhost', '127.0.0.1'].includes(host) && __ENV.ALLOW_REMOTE !== 'true') {
  throw new Error(`BASE_URL ${BASE_URL} is not this computer. Load-test the local backend (loadtest/README.md), or pass -e ALLOW_REMOTE=true if you really mean it.`);
}

const STAGES = {
  smoke: [
    { duration: '5s', target: 2 },
    { duration: '25s', target: 2 },
  ],
  load: [
    { duration: '1m', target: VUS },
    { duration: '3m', target: VUS },
    { duration: '1m', target: 0 },
  ],
  stress: [
    { duration: '1m', target: 50 },
    { duration: '2m', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '2m', target: 100 },
    { duration: '1m', target: 200 },
    { duration: '2m', target: 200 },
    { duration: '1m', target: 0 },
  ],
  spike: [
    { duration: '30s', target: 10 },
    { duration: '10s', target: 150 },
    { duration: '1m', target: 150 },
    { duration: '10s', target: 10 },
    { duration: '1m', target: 10 },
    { duration: '10s', target: 0 },
  ],
};
if (!STAGES[TEST_TYPE]) throw new Error(`TEST_TYPE must be one of: ${Object.keys(STAGES).join(', ')}`);

export const options = {
  // k6 empties each user's cookies after every round by default; each user here
  // signs in once and keeps its session cookie, like a browser does.
  noCookiesReset: true,
  // Response-time statistics shown in the summary and saved by --summary-export.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    [TEST_TYPE]: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STAGES[TEST_TYPE],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Pass/fail targets. A stress test is expected to cross them; the point is when.
    http_req_failed: ['rate<0.01'],                                // under 1% of requests fail
    'http_req_duration{kind:page}': ['p(95)<1000', 'p(99)<2500'],  // page data: 95% under 1 s
    'http_req_duration{kind:poll}': ['p(95)<500'],                 // change checks: 95% under 0.5 s
    'http_req_duration{kind:login}': ['p(95)<3000'],               // sign-in (password hashing is slow on purpose)
    checks: ['rate>0.99'],
  },
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

// Runs once before the test. The load-test backend (loadtest/local.mjs) raises
// the per-address limit of 600 requests a minute; a backend that still has it
// is a normal one, such as `npm run dev` on port 4000, which uses the live
// database from .env. Every virtual user comes from this one address, so it
// would also answer most requests with 429.
export function setup() {
  // Not signed in yet, so 401 is the expected answer.
  const res = http.get(`${BASE_URL}/api/auth/session`, { tags: { name: 'setup' }, headers: { 'X-Forwarded-For': '10.255.255.254' }, responseCallback: http.expectedStatuses(401) });
  if (res.status === 0) throw new Error(`No backend at ${BASE_URL}: start it with "node loadtest/local.mjs server".`);
  const limit = Number(Object.entries(res.headers).find(([key]) => key.toLowerCase() === 'ratelimit-limit')?.[1]);
  if (limit && limit <= 600 && __ENV.ALLOW_REMOTE !== 'true') {
    throw new Error(`${BASE_URL} allows ${limit} requests a minute per address, so it is not the load-test backend `
      + '(the one on port 4000 uses the live database). Start "node loadtest/local.mjs server" and use port 4001.');
  }
  // Saved in --summary-export, for show-summary.mjs.
  return { label: 'All modules together (members and administrators)', testType: TEST_TYPE, stages: STAGES[TEST_TYPE] };
}

// Per virtual user: each one runs in its own copy of this script.
let role = null;
let cursor = '';
let reported = 0;

// Prints what went wrong for the first few failed requests of each user, since
// the summary only counts them.
function reportFailure(name, res) {
  if (res.status === 200 || reported >= 5) return;
  reported += 1;
  const reason = res.status ? `HTTP ${res.status}` : `no answer (${res.error})`;
  console.warn(`VU ${exec.vu.idInTest}: ${name} -> ${reason} ${String(res.body || '').slice(0, 200)}`);
}

function userFor(vu) {
  if ((vu - 1) % ADMIN_EVERY === 0) return { role: 'admin', username: ADMIN_USERNAME, password: ADMIN_PASSWORD };
  const n = ((vu - 1) % MEMBER_COUNT) + 1;
  return { role: 'member', username: `member${String(n).padStart(3, '0')}`, password: MEMBER_PASSWORD };
}

function signIn() {
  const user = userFor(exec.vu.idInTest);
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ usernameOrEmail: user.username, password: user.password }),
    { headers: userHeaders(JSON_HEADERS), tags: { name: 'POST /api/auth/login', kind: 'login' } },
  );
  if (check(res, { 'signed in': (r) => r.status === 200 })) return user.role;
  reportFailure(`POST /api/auth/login as ${user.username}`, res);

  // Wrong password (401) or inactive account (403): every other user would fail
  // the same way and add to the lockout, so stop. A 429 (too many attempts) is a
  // result: it counts as an error and this user tries again later.
  if ([401, 403].includes(res.status)) {
    exec.test.abort(`Sign-in as ${user.username} failed (${res.status}): ${res.body}`);
  }
  sleep(res.status === 429 ? 10 : 5); // overloaded, timed out or refused: try again on the next round
  return null;
}

// One page: its requests go out together, as a browser sends them.
function openPage(title, paths) {
  group(title, () => {
    const names = paths.map(([path, name]) => name || `GET ${path}`);
    const responses = http.batch(paths.map(([path], i) => ['GET', `${BASE_URL}${path}`, null, {
      tags: { name: names[i], kind: 'page' },
      headers: userHeaders(),
    }]));
    responses.forEach((res, i) => {
      check(res, { 'status 200': (r) => r.status === 200 });
      reportFailure(names[i], res);
      if (res.status === 401) role = null; // session ended: sign in again
    });
  });
}

// Reading a page for a while; the app asks every 3 seconds what changed.
function readFor(minSeconds, maxSeconds) {
  const seconds = minSeconds + Math.random() * (maxSeconds - minSeconds);
  if (!POLL) {
    sleep(seconds);
    return;
  }
  const end = Date.now() + seconds * 1000;
  while (role && Date.now() < end) {
    sleep(Math.min(POLL_SECONDS, Math.max(0.1, (end - Date.now()) / 1000)));
    const res = http.get(`${BASE_URL}/api/events/changes${cursor ? `?after=${cursor}` : ''}`, {
      headers: userHeaders({ 'X-Session-Activity': 'passive' }),
      tags: { name: 'GET /api/events/changes', kind: 'poll' },
    });
    check(res, { 'status 200': (r) => r.status === 200 });
    reportFailure('GET /api/events/changes', res);
    if (res.status === 200) cursor = res.json('cursor') || cursor;
    if (res.status === 401) role = null;
  }
}

function memberVisit() {
  openPage('member: dashboard', [
    ['/api/auth/me'],
    ['/api/members/me'],
    ['/api/notifications'],
    ['/api/announcements'],
  ]);
  readFor(5, 15);
  openPage('member: loans', [
    ['/api/members/me/loan-history'],
    ['/api/loans/policy'],
  ]);
  readFor(5, 15);
  openPage('member: activity', [
    ['/api/members/me/activity'],
    ['/api/members/me/attendance'],
  ]);
  readFor(5, 15);
}

function adminVisit() {
  const page = 1 + Math.floor(Math.random() * Math.max(1, Math.ceil(MEMBER_COUNT / 20)));
  openPage('admin: dashboard', [
    ['/api/auth/me'],
    ['/api/admin/dashboard'],
    ['/api/notifications'],
    ['/api/announcements'],
  ]);
  readFor(5, 10);
  openPage('admin: members', [
    [`/api/members?page=${page}&limit=20`, 'GET /api/members?page=N'],
    ['/api/members/statistics'],
  ]);
  readFor(5, 10);
  openPage('admin: loans', [
    ['/api/admin/loans'],
    ['/api/admin/loan-requests'],
  ]);
  readFor(5, 10);
  openPage('admin: analytics', [
    ['/api/admin/analytics'],
  ]);
  readFor(5, 10);
  openPage('admin: attendance', [
    ['/api/attendance/dashboard'],
    ['/api/attendance/activities'],
  ]);
  readFor(5, 10);
}

export default function () {
  if (!role) {
    role = signIn();
    if (!role) return;
  }
  if (role === 'admin') adminVisit();
  else memberVisit();
}
