import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const { Pool } = pg;
const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      options: '-c timezone=Asia/Manila',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

function requirePool() {
  if (!pool) {
    throw new Error('SUPABASE_DB_URL or DATABASE_URL must be configured.');
  }
  return pool;
}

export const query = (text, params) => requirePool().query(text, params);
export const getPool = () => requirePool();

export default pool;
