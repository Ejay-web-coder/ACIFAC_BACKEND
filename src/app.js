import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { query } from './config/db.js';
import { isAllowedOrigin, isProduction } from './config/env.js';
import { csrfProtection, noStore, securityHeaders } from './middleware/security.js';
import { errorHandler } from './utils/http.js';
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import memberRoutes from './routes/memberRoutes.js';
import machineryRoutes from './routes/machineryRoutes.js';
import kadiwaRoutes from './routes/kadiwaRoutes.js';
import ocrRoutes from './routes/ocrRoutes.js';
import loanRoutes from './routes/loanRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import { announcementRoutes, eventRoutes, legalDocumentRoutes, notificationRoutes } from './routes/communicationRoutes.js';
import { isListening } from './services/events.js';
import { refreshLoanStatuses } from './services/loanService.js';
import { refreshRentalStatuses } from './controllers/machineryController.js';
import { flushSmsOutbox } from './services/smsService.js';

export function createApp() {
  const app = express();
  // Hosting platforms (Render, Railway, Fly, etc.) terminate TLS at a proxy.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.disable('x-powered-by');

  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Session-Activity'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/', (req, res) => {
    res.status(200).json({ name: 'ACIFAC backend', status: 'running', health: '/api/health' });
  });

  app.get('/api/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.status(200).json({ ok: true, message: 'Backend healthy.', liveUpdates: isListening() });
    } catch (error) {
      console.error('Health check failed:', error.message);
      res.status(500).json({ ok: false, message: 'Database unavailable.' });
    }
  });

  // Vercel Cron replacement for the hourly timer in server.js. Vercel sends
  // "Authorization: Bearer <CRON_SECRET>" with every scheduled invocation.
  // It runs at 00:00 UTC (08:00 in Manila), inside the SMS sending hours, so
  // reminder texts queued overnight go out every morning even if nobody opens
  // the system that day.
  app.get('/api/cron/refresh-loans', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    await Promise.all([refreshLoanStatuses({ force: true }), refreshRentalStatuses()]);
    await flushSmsOutbox();
    return res.status(200).json({ ok: true });
  });

  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 600),
    standardHeaders: true,
    legacyHeaders: false,
    // Live updates and the every-3-seconds change poll.
    skip: (req) => req.path === '/events' || req.path === '/events/changes',
    message: { success: false, message: 'Too many requests. Please slow down.' },
  }));
  app.use('/api', noStore, csrfProtection);

  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/members', memberRoutes);
  app.use('/api/loans', loanRoutes);
  app.use('/api/machinery', machineryRoutes);
  app.use('/api/kadiwa', kadiwaRoutes);
  app.use('/api/ocr', ocrRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/announcements', announcementRoutes);
  app.use('/api/legal-documents', legalDocumentRoutes);
  app.use('/api/events', eventRoutes);

  app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Endpoint not found.' }));
  app.use(errorHandler);

  if (!isProduction) app.set('json spaces', 0);
  return app;
}
