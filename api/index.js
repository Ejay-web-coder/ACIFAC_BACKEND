import { createApp } from '../src/app.js';
import { applyMigrations, autoMigrateEnabled } from '../src/services/migrations.js';

// Vercel entry point: every request is rewritten here (see vercel.json) and
// handled by the same Express app that src/server.js runs locally.
// Serverless functions cannot hold a LISTEN connection or run timers, so live
// updates are off (DISABLE_LIVE_UPDATES=true) and the loan refresh runs as a
// Vercel Cron job instead (GET /api/cron/refresh-loans).
const app = createApp();

// Pending migrations are applied once per cold start, before the first request
// is handled. A failure is logged and retried on the next cold start.
let migrated = null;

export default async function handler(req, res) {
  if (autoMigrateEnabled()) {
    migrated ??= applyMigrations().catch((error) => console.error(error.message));
    await migrated;
  }
  return app(req, res);
}
