import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import memberRoutes from './routes/memberRoutes.js';
import machineryRoutes from './routes/machineryRoutes.js';
import kadiwaRoutes from './routes/kadiwaRoutes.js';
import ocrRoutes from './routes/ocrRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-cookie-secret'));

app.get('/', (req, res) => {
  res.status(200).json({ name: 'ACIFAC backend', status: 'running', health: '/api/health' });
});

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.status(200).json({ ok: true, message: 'Backend healthy.' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ ok: false, message: 'Database unavailable.' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/machinery', machineryRoutes);
app.use('/api/kadiwa', kadiwaRoutes);
app.use('/api/ocr', ocrRoutes);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) {
    return next(err);
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'Document file size must not exceed 10 MB.' });
  }
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ success: false, message: 'This document file type is not supported.' });
  }
  return res.status(500).json({ message: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`ACIFAC backend running on http://localhost:${PORT}`);
});
