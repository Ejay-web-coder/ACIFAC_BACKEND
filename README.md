# ACIFAC Backend

Express API for the ACIFAC Monitoring and Data Management System.

```
React (Vercel)  →  Express API (this repo)  →  Supabase PostgreSQL (+ private Supabase Storage)
```

* Authentication: bcrypt passwords, `users` + `sessions` tables, httpOnly `session_token` cookie (8 h).
* Every route checks the session, the account status (INACTIVE/LOCKED sessions are revoked immediately),
  forced password changes, and the role. Members can only read their own records.
* Login security (all enforced in PostgreSQL, so it holds across browsers, tabs and server instances):
  * the 3rd wrong password in a row locks that account for 20 minutes, whichever sign-in name is used;
    names with no account lock the same way, and each client address is locked after
    `LOGIN_IP_MAX_FAILURES` (default 20) failures (`login_throttles`);
  * a session ends after 20 minutes without activity (`sessions.last_activity_at`). Requests sent with
    `X-Session-Activity: passive` (the browser's background refreshes) and the live-update stream don't count;
  * forgot password emails a 6-digit code (bcrypt-hashed in `password_reset_codes`, 10 minutes, 5 attempts,
    60-second resend cooldown, 5 codes per address and `RESET_CODES_PER_IP_PER_HOUR` (default 15) per client
    address per hour). Every address gets the same reply. A verified code sets a short-lived httpOnly
    `password_reset_grant` cookie that allows one password change. The change ends all sessions and lifts a
    lockout. Emailed links (account setup, office resets) still use `password_reset_tokens`.
  * Endpoints: `POST /api/auth/login`, `/logout`, `/forgot-password`, `/verify-reset-code`,
    `/reset-password`; `GET /api/auth/me`, `/session`.
* Money is calculated in PostgreSQL `NUMERIC` or integer centavos, never floating point.
* Live updates: database triggers → `pg_notify` → one `LISTEN` connection → Server-Sent Events
  (`GET /api/events`). Events carry only `{table, op}`; browsers re-fetch through the authorised API.

## Local development

```bash
cp .env.example .env        # fill in SUPABASE_DB_URL etc.
npm install
npm run migrate             # optional: npm start / npm run dev also apply new sql/*.sql files on start
ADMIN_USERNAME=admin ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='A-Strong-Pass1!' npm run create-admin
npm run dev
```

### Sample data (seeder)

```bash
SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/acifac_dev npm run seed            # migrate, then fill an empty database
SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/acifac_dev npm run seed -- --fresh # empty it first, then fill it
SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/acifac_dev npm run seed -- --add-members=500
```

In PowerShell, set the variable for the command and remove it afterwards, so `npm run dev` in the same
terminal still uses `.env`:

```powershell
$env:SUPABASE_DB_URL='postgres://postgres:postgres@localhost:5432/acifac_dev'; npm run seed; Remove-Item Env:SUPABASE_DB_URL
```

`--add-members=N` adds N more members, each with an active login (`member001`, `member002`, ... /
`Member@12345`, numbering continues on a second run). On an empty database it comes on top of the full
sample data; on a database the seeder already filled it adds only these members.

Fills a database with 15 members (share capital, savings), loan applications and loans with on-time,
late and overdue payments, machinery services, rentals and expenses, ten days of Kadiwa sales,
activities with attendance, and announcements. Dates are counted from today. It signs in as
`admin` / `Admin@12345`; every member has an active login, first.lastname (`juan.delacruz`,
`maria.santos`, ...) / `Member@12345`.

* It only runs against a database on this computer, because `.env` points at the live one (set
  `SUPABASE_DB_URL` for the command as above; `DATABASE_SSL=disable` is set for you). To fill a Supabase
  database on purpose, set `SEED_ALLOW_REMOTE=true`, `SEED_ADMIN_PASSWORD` and `SEED_MEMBER_PASSWORD` (a strong
  one: the sample logins are then on a public site; an existing administrator keeps their own password).
* It refuses a database that already has members (`--add-members` only adds to one the seeder filled),
  and `--fresh` (drop and re-migrate everything) is local only.
* `--alongside-existing` adds the sample next to real members (the live database was filled this way on
  2026-10-15, with `--add-members=500`). Real records are not touched: no announcements, no activity or rental
  from today on, no attendance records for real members, and notifications about the sample come already
  read for the office. Totals, reports and net income do include the sample records.
* Everything is saved in one transaction, through the app's own code where it holds business rules
  (`insertKadiwaSale`, `allocatePayment`, loan applications, ...) and a few statements per table for members,
  share capital and savings, so it takes about 4 minutes against Supabase. Each part of the system is one
  file in `scripts/seeders/`; to add one, export `async function (ctx)` from a new file and list it in
  `SEEDERS` in `scripts/seed.js`.

### Tests

```bash
npm test                                   # unit tests
TEST_DATABASE_URL=postgres://... npm test  # + end-to-end API tests on a disposable, migrated database
```

The integration suite covers authentication, authorisation, members, savings, share capital,
loans/installments/overdue, machinery, Kadiwa stock, OCR, notifications, announcements, live updates,
analytics, session revocation, login lockouts, emailed reset codes and the inactivity timeout.

## Deployment (Render, see `render.yaml`)

1. Render → New → Blueprint → select this repository (branch to deploy).
2. Enter the secret variables (`SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `CORS_ORIGIN`, `FRONTEND_URL`, email and OCR keys). `SUPABASE_DB_URL` must be the **session pooler
   (port 5432) or direct** connection string; the transaction pooler (6543) cannot `LISTEN`.
3. Migrations run automatically: on every start the server applies any new `sql/*.sql` file
   (tracked in `app_schema_migrations`) before accepting requests, and exits if one fails, so a bad
   deploy keeps the previous version running. On Vercel they run on the first request after a cold
   start. Set `AUTO_MIGRATE=false` to turn this off and use `npm run migrate` instead.
   After the first deploy run `npm run create-admin` with `ADMIN_*` variables to create the first administrator.
4. Check `https://<service>.onrender.com/api/health` → `{"ok":true,"liveUpdates":true}`.

Any Node 20+ host works the same way (`npm ci && npm start`); keep it a long-running server so SSE
and the hourly overdue job run.

## Business rules implemented (from the existing system)

| Area | Rule |
|---|---|
| Loan limit | farm area (ha) × ₱50,000 |
| Interest | 2.5% of principal, flat for the whole term (legacy requests without a rate keep 8%) |
| Schedule | `term` equal monthly installments, first due one month after approval; last absorbs rounding |
| Payments | applied to the oldest unpaid installment, interest portion first |
| Overdue | a loan is overdue when any installment is unpaid after its due date (no grace period) |
| Share capital | `share_contributions`, capped at ₱20,000 per member |
| Savings | separate `savings_transactions` ledger (deposits), not capped, not share capital |
| Member name | `members.full_name` is generated: first, middle, last name and suffix, single-spaced |
| Rentals | days = end date − start date (minimum 1); fee = daily fee × days; no overlapping bookings. An approved `rental_requests` row becomes a `machinery_operations` booking |
| Machinery services | `machinery_services` records each job done (per ha, per 100 bags or per day) and its payments, for the PhilMech report. Bookings stay in `machinery_operations`; a service may link to its rental request |
| Kadiwa | selling inventory items decrements stock inside a locked transaction; overselling is rejected; cash only (`kadiwa_sales.payment_method`) |
| Attendance | `activities` (community development, educational and training, meeting; scheduled/completed/cancelled) and `activity_attendance` (one row per activity and member: present, late, absent or excused). The office marks members from the activity date on; **Finalize** records every unmarked active member absent and completes the activity. Rate = (present + late) ÷ eligible completed activities with final attendance × 100, N/A when there are none; cancelled and not-yet-final activities are never counted. Corrections after finalizing need a reason and are kept in `audit_logs`. Office endpoints: `/api/attendance/*`; members read their own at `GET /api/members/me/attendance` |
