# Load testing with Grafana k6

`acifac.k6.js` simulates members and administrators using the system at the same time:
each virtual user signs in, opens pages (their API requests go out together, like a
browser) and, while reading, checks for changes every 3 seconds like the app does on
Vercel. It only reads, so a run adds no records apart from sessions and sign-in audit
entries.

Run it against a **local** backend and database, never the live one. The `.env` file
points at the live Supabase database, so `npm run dev` on port 4000 is not safe to
load-test. `local.mjs` starts a backend on port 4001 with every live setting
replaced by a local or empty value.

## 1. Install k6 (once)

```powershell
winget install k6 --source winget     # or: choco install k6
k6 version
```

## 2. Create and fill a local database (once)

PostgreSQL 18 is installed as a Windows service on port 5432. Use its `postgres`
password below.

```powershell
& "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres -E UTF8 -T template0 --locale=C acifac_loadtest
$env:LOADTEST_DB_URL = 'postgres://postgres:YOUR_PASSWORD@localhost:5432/acifac_loadtest'
node loadtest/local.mjs seed --add-members=200
```

This creates `admin` / `Admin@12345` and member logins `member001` ... `member300`
(the 100 sample members plus 200 more) with the password `Member@12345`.

## 3. Start the load-test backend (terminal 1)

```powershell
$env:LOADTEST_DB_URL = 'postgres://postgres:YOUR_PASSWORD@localhost:5432/acifac_loadtest'
node loadtest/local.mjs server
```

Wait for `ACIFAC backend running on port 4001`.

## 4. Run k6 (terminal 2)

```powershell
k6 run -e MEMBER_COUNT=300 loadtest/acifac.k6.js                      # smoke: 2 users, 30 s
k6 run -e MEMBER_COUNT=300 -e TEST_TYPE=load   loadtest/acifac.k6.js  # 50 users, ~5 min
k6 run -e MEMBER_COUNT=300 -e TEST_TYPE=load -e VUS=100 loadtest/acifac.k6.js  # 100 users, ~5 min
k6 run -e MEMBER_COUNT=300 -e TEST_TYPE=stress loadtest/acifac.k6.js  # 50 -> 100 -> 200 users, ~10 min
k6 run -e MEMBER_COUNT=300 -e TEST_TYPE=spike  loadtest/acifac.k6.js  # 10 -> 150 users at once
```

Always run the smoke test first. If it fails, fix that before adding load.
The smoke test is always 2 users. For more, use `TEST_TYPE=load` with `-e VUS=<users>`
(`-Vus <users>` for `run-modules.ps1`).

## 5. Test every module separately

`modules.k6.js` load-tests one module at a time and reports each of its endpoints
separately. `run-modules.ps1` runs all 15 modules one after another and puts the
results in one table:

| Module | Signs in as | Endpoints |
|---|---|---|
| `auth` | member | login, `/api/auth/me`, `/api/auth/session`, logout (every round) |
| `dashboard` | admin | dashboard, share capital levels |
| `members` | admin | list, search, statistics, archived, members without accounts, member details, dividend |
| `savings` | admin | savings records, savings by member, one member's savings |
| `loans` | admin | loans, loan details, payments, loan requests, loan history, loan policy, farm inputs |
| `machinery` | admin | machines, catalog, availability, services, service details, rates, expenses, period balances, PhilMech report and form |
| `kadiwa` | admin | store data, branches, sales, analytics, member search |
| `vendor` | Kadiwa vendor | vendor store, sales, analytics, activity |
| `attendance` | admin | dashboard, activities, activity details, attendees, history, records, participation report, one member |
| `analytics` | admin | analytics, revenue, Kadiwa products, machinery |
| `ocr` | admin | scanned documents list, forms (scanning itself calls the AI service, so it is not load-tested) |
| `users` | admin | accounts, account details, audit log |
| `communication` | member | notifications, announcements, legal documents, change checks |
| `about` | member | about, org chart, policies |
| `member-portal` | member | my data, my loans, my activity, my attendance, machinery catalog |

The vendor module uses the account `loadtest-vendor` / `Vendor@12345`. The admin
creates it in the local database the first time.

With the backend running in terminal 1, in terminal 2:

```powershell
# Quick check of every module (about 10 minutes)
powershell -ExecutionPolicy Bypass -File loadtest/run-modules.ps1 -TestType smoke

# The load test of every module: 30 users each for 2 minutes (about 50 minutes)
powershell -ExecutionPolicy Bypass -File loadtest/run-modules.ps1 -TestType load

# Only some modules, or more users
powershell -ExecutionPolicy Bypass -File loadtest/run-modules.ps1 -TestType load -Modules loans,kadiwa -Vus 50

# One module by hand
k6 run -e MODULE=loans -e TEST_TYPE=load -e MEMBER_COUNT=300 loadtest/modules.k6.js
```

Each run saves to `loadtest/results/<test type>-<date>-<time>/`:

- `<module>.html`: charts for that module (open it in a browser).
- `<module>.json`: its raw numbers.
- `summary.csv` (opens in Excel) and `summary.md`: every module together, one row per
  endpoint plus a TOTAL row per module, with requests, requests per second, average,
  p95 and maximum response time, error rate and PASS/FAIL.

To rebuild the table from a results folder: `node loadtest/module-table.mjs loadtest/results/<folder>`.

### One k6 summary per module (for screenshots)

`show-summary.mjs` clears the terminal and prints a saved module run as a k6 summary
with a title (`MODULE 5: LOANS`), the run details, every threshold with ✓ or ✗, the
totals and PASSED/FAILED:

```powershell
node loadtest/show-summary.mjs            # every module of the newest run, one screen each (Enter = next)
node loadtest/show-summary.mjs loans      # one module (or its number: 5)
node loadtest/show-summary.mjs loadtest/results/load-20261112-1000 loans   # from an older run
```

Modules are numbered 1 auth, 2 dashboard, 3 members, 4 savings, 5 loans, 6 machinery,
7 kadiwa, 8 vendor, 9 attendance, 10 analytics, 11 ocr, 12 users, 13 communication,
14 about, 15 member-portal. Use `--title "MODULE 3: LOAN MANAGEMENT"` for your own names.
For the all-modules test, save its result first:
`k6 run -e MEMBER_COUNT=300 -e TEST_TYPE=load --summary-export loadtest/results/all-load.json loadtest/acifac.k6.js`,
then `node loadtest/show-summary.mjs loadtest/results/all-load.json`.

### Live dashboard and an HTML report

k6 has a built-in web dashboard. It shows live graphs at http://localhost:5665 during
the run and can save a report you can screenshot afterwards:

```powershell
New-Item -ItemType Directory -Force loadtest/results | Out-Null
$env:K6_WEB_DASHBOARD = 'true'
$env:K6_WEB_DASHBOARD_EXPORT = 'loadtest/results/load-report.html'
k6 run -e MEMBER_COUNT=300 -e TEST_TYPE=load loadtest/acifac.k6.js
```

Add `--summary-export loadtest/results/load-summary.json` for the numbers as JSON.
`loadtest/results/` is ignored by git.

### Grafana dashboards (optional)

- **Grafana Cloud k6** (free tier): run `k6 cloud login --token <token>`, then
  `k6 run --out cloud ...`. The test still runs on this computer against
  localhost; only the results are uploaded to Grafana's k6 dashboards. Don't use
  `k6 cloud run`: that runs the test from Grafana's servers, which cannot reach
  localhost.
- **Self-hosted Grafana**: send the results to Prometheus with
  `k6 run --out experimental-prometheus-rw ...` (set `K6_PROMETHEUS_RW_SERVER_URL`)
  and import the official k6 dashboard into Grafana.

## 6. Reading the results

| Metric | Meaning | Target in this script |
|---|---|---|
| `http_req_duration{kind:page}` p(95) | 95% of page requests finished within this time | < 1 s |
| `http_req_duration{kind:poll}` p(95) | change checks (every 3 s per open page) | < 0.5 s |
| `http_req_duration{kind:login}` p(95) | sign-in (password hashing is slow on purpose) | < 3 s |
| `http_req_failed` | share of requests that failed (non-2xx/3xx or timeout) | < 1% |
| `checks` | share of responses that were 200 | > 99% |
| `http_reqs` | requests per second the backend handled | |
| `vus` | users active at that moment | |

A ✓ or ✗ next to each threshold shows whether the run met it, and k6 exits with code
99 when one fails. In a stress test, look for the user count where p(95) starts
climbing or errors appear: that is the system's capacity on this machine.

## Options

`-e BASE_URL=...` (default `http://localhost:4001`), `-e ADMIN_EVERY=10` (1 user in 10
is an admin), `-e POLL=false` (no change checks), `-e ADMIN_USERNAME`, `-e ADMIN_PASSWORD`,
`-e MEMBER_PASSWORD`. For the backend: `$env:DATABASE_POOL_MAX='20'` before starting it
shows whether the database pool (10 connections) is the bottleneck.

## Limits of a local test

- k6, the backend and PostgreSQL share this computer's CPU and memory, so the
  numbers are lower than a server would reach. Close other programs during a run.
- Production runs on Vercel (serverless, Sydney) with Supabase. It has network
  latency and several function instances, so local numbers measure the code and
  the queries, not the hosting.
- To start over, drop the database
  (`& "C:\Program Files\PostgreSQL\18\bin\dropdb.exe" -U postgres acifac_loadtest`)
  and repeat step 2.
