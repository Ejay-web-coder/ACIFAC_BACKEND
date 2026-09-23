import fs from 'node:fs';
import pg from 'pg';
import './env.js';

const { Pool, types } = pg;

// DATE columns are calendar dates, not instants. Returning them as the raw
// 'YYYY-MM-DD' string prevents Node's local time zone from shifting them.
types.setTypeParser(1082, (value) => value);
// NUMERIC stays a string so money is never converted to a float by the driver.

const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

function buildSslConfig() {
  const mode = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'disable' || mode === 'false') return false;
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) {
    return { ca: ca.includes('BEGIN CERTIFICATE') ? ca : fs.readFileSync(ca, 'utf8'), rejectUnauthorized: true };
  }
  // Supabase requires TLS. Without its CA certificate the connection is still
  // encrypted, but the server certificate is not verified.
  return { rejectUnauthorized: false };
}

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: buildSslConfig(),
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

if (pool) {
  pool.on('error', (error) => console.error('Idle database client error:', error.message));
}

function requirePool() {
  if (!pool) {
    throw new Error('SUPABASE_DB_URL or DATABASE_URL must be configured.');
  }
  return pool;
}

export const query = (text, params) => requirePool().query(text, params);
export const getPool = () => requirePool();
export const getDatabaseUrl = () => databaseUrl;

// A dedicated (non-pooled) connection, used for LISTEN. Requires a direct or
// session-mode connection string; Supabase's transaction pooler cannot LISTEN.
export function createDedicatedClient() {
  const url = process.env.SUPABASE_DB_LISTEN_URL || databaseUrl;
  if (!url) throw new Error('SUPABASE_DB_URL or DATABASE_URL must be configured.');
  return new pg.Client({ connectionString: url, ssl: buildSslConfig() });
}

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
export async function withTransaction(fn) {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
