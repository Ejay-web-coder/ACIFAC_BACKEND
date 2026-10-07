import http from 'node:http';
import { createApp } from './app.js';
import { isProduction, validateProductionEnv } from './config/env.js';
import { startEventListener, stopEventListener } from './services/events.js';
import { refreshLoanStatuses } from './services/loanService.js';
import { getPool } from './config/db.js';
import { applyMigrations, autoMigrateEnabled } from './services/migrations.js';

const missing = validateProductionEnv();
if (missing.length) {
  console.error(`Missing required production configuration: ${missing.join(', ')}`);
  process.exit(1);
}

const app = createApp();
const PORT = Number(process.env.PORT || 4000);
// How long a request that arrives during start-up waits for the database check.
const STARTUP_WAIT_MS = 60000;

// The port is opened first, so a second copy of the backend stops at once
// instead of running beside this one. New sql/*.sql files are then applied
// before any request is answered: requests that arrive meanwhile (a login
// right after a restart) wait for it instead of being refused. If a migration
// fails the process exits, so it never serves code against an old schema.
let ready = false;
let markReady;
const whenReady = new Promise((resolve) => { markReady = resolve; });

function holdUntilReady(req, res) {
  let answered = false;
  const timer = setTimeout(() => {
    answered = true;
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
    res.end(JSON.stringify({ success: false, message: 'The ACIFAC server is still starting. Please try again in a moment.' }));
  }, STARTUP_WAIT_MS);
  void whenReady.then(() => {
    clearTimeout(timer);
    if (!answered) app(req, res);
  });
}

const server = http.createServer((req, res) => (ready ? app(req, res) : holdUntilReady(req, res)));

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use: the ACIFAC backend is probably already running in another terminal. Use that one, or stop it (Ctrl+C) before starting this one.`
    : `Unable to open port ${PORT}: ${error.message}`);
  process.exit(1);
});

let loanTimer = null;

server.listen(PORT, async () => {
  console.log(`ACIFAC backend: port ${PORT} open, checking the database...`);
  if (autoMigrateEnabled()) {
    try {
      await applyMigrations();
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
  ready = true;
  markReady();
  console.log(`ACIFAC backend running on port ${PORT} (${isProduction ? 'production' : 'development'})`);

  if (process.env.DISABLE_LIVE_UPDATES !== 'true') startEventListener();
  // Overdue detection and payment-due reminders: once at start, then hourly.
  void refreshLoanStatuses({ force: true });
  loanTimer = setInterval(() => void refreshLoanStatuses({ force: true }), 60 * 60 * 1000);
  loanTimer.unref();
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  clearInterval(loanTimer);
  await stopEventListener();
  server.close(() => {
    getPool().end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
