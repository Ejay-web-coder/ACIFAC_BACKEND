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
