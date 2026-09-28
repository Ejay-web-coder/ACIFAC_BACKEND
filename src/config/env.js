import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local development reads ACIFAC_BACKEND/.env. Hosting platforms inject real
// environment variables, which take precedence over the file.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TIME_ZONE_PATTERN = /^[A-Za-z_]+(\/[A-Za-z_]+)*$/;

export const isProduction = process.env.NODE_ENV === 'production';
export const TIME_ZONE = TIME_ZONE_PATTERN.test(process.env.ACIFAC_TIME_ZONE || '') ? process.env.ACIFAC_TIME_ZONE : 'Asia/Manila';

// SQL expression for "today" in the cooperative's time zone. Safe to inline:
// TIME_ZONE only ever contains a validated IANA zone name.
export const SQL_TODAY = `((NOW() AT TIME ZONE '${TIME_ZONE}')::date)`;

export function getAllowedOrigins() {
  return String(process.env.CORS_ORIGIN || (isProduction ? '' : 'http://localhost:5173'))
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

// In development the Vite dev server is also opened from this computer's
// network address (a phone on the same Wi-Fi, or 127.0.0.1), and that address
// changes whenever the network does. Outside production, plain-http origins
// on localhost or a private network address are accepted as well.
const PRIVATE_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}):\d{2,5}$/;

export function isAllowedOrigin(origin) {
  const value = String(origin || '').replace(/\/$/, '');
  return getAllowedOrigins().includes(value) || (!isProduction && PRIVATE_DEV_ORIGIN.test(value));
}

export function getFrontendUrl() {
  return String(process.env.FRONTEND_URL || process.env.APP_URL || (isProduction ? '' : 'http://localhost:5173')).replace(/\/$/, '');
}

// Fails fast in production when required configuration is missing. Values are
// never printed, only variable names.
export function validateProductionEnv() {
  if (!isProduction) return [];
  const missing = [];
  if (!process.env.SUPABASE_DB_URL && !process.env.DATABASE_URL) missing.push('SUPABASE_DB_URL (or DATABASE_URL)');
  if (!process.env.CORS_ORIGIN) missing.push('CORS_ORIGIN');
  if (!process.env.FRONTEND_URL && !process.env.APP_URL) missing.push('FRONTEND_URL');
  if (getAllowedOrigins().includes('*')) missing.push('CORS_ORIGIN must list explicit origins, not *');
  return missing;
}
