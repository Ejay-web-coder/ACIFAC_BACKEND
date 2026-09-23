import { createApp } from './app.js';
import { isProduction, validateProductionEnv } from './config/env.js';
import { startEventListener, stopEventListener } from './services/events.js';
import { refreshLoanStatuses } from './services/loanService.js';
import { getPool } from './config/db.js';

const missing = validateProductionEnv();
if (missing.length) {
  console.error(`Missing required production configuration: ${missing.join(', ')}`);
  process.exit(1);
}

const app = createApp();
const PORT = Number(process.env.PORT || 4000);

const server = app.listen(PORT, () => {
  console.log(`ACIFAC backend running on port ${PORT} (${isProduction ? 'production' : 'development'})`);
});

if (process.env.DISABLE_LIVE_UPDATES !== 'true') startEventListener();

// Overdue detection and payment-due reminders: once at start, then hourly.
void refreshLoanStatuses({ force: true });
const loanTimer = setInterval(() => void refreshLoanStatuses({ force: true }), 60 * 60 * 1000);
loanTimer.unref();

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
