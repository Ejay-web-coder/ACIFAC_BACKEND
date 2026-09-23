import { createApp } from '../src/app.js';

// Vercel entry point: every request is rewritten here (see vercel.json) and
// handled by the same Express app that src/server.js runs locally.
// Serverless functions cannot hold a LISTEN connection or run timers, so live
// updates are off (DISABLE_LIVE_UPDATES=true) and the loan refresh runs as a
// Vercel Cron job instead (GET /api/cron/refresh-loans).
export default createApp();
