# ACIFAC Backend

Express API for the ACIFAC Monitoring and Data Management System.

```
React (Vercel)  →  Express API (this repo)  →  Supabase PostgreSQL (+ private Supabase Storage)
```

* Authentication: bcrypt passwords, `users` + `sessions` tables, httpOnly `session_token` cookie (8 h).
* Every route checks the session, the account status (INACTIVE/LOCKED sessions are revoked immediately),
  forced password changes, and the role. Members can only read their own records.
* Money is calculated in PostgreSQL `NUMERIC` or integer centavos, never floating point.
* Live updates: database triggers → `pg_notify` → one `LISTEN` connection → Server-Sent Events
  (`GET /api/events`). Events carry only `{table, op}`; browsers re-fetch through the authorised API.

## Local development

```bash
cp .env.example .env        # fill in SUPABASE_DB_URL etc.
npm install
npm run migrate             # applies sql/*.sql once each (tracked in app_schema_migrations)
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
analytics and session revocation.

## Deployment (Render, see `render.yaml`)

1. Render → New → Blueprint → select this repository (branch to deploy).
2. Enter the secret variables (`SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `CORS_ORIGIN`, `FRONTEND_URL`, email and OCR keys). `SUPABASE_DB_URL` must be the **session pooler
   (port 5432) or direct** connection string; the transaction pooler (6543) cannot `LISTEN`.
3. After the first deploy run `npm run migrate` from a Render shell (safe to repeat), then
   `npm run create-admin` with `ADMIN_*` variables to create the first administrator.
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
| Rentals | days = end date − start date (minimum 1); fee = daily fee × days; no overlapping bookings |
| Kadiwa | selling inventory items decrements stock inside a locked transaction; overselling is rejected |
