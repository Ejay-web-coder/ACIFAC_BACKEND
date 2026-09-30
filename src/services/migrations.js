import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../config/db.js';

const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
const LOCK_KEY = 'acifac-schema-migrations';

// Applies every sql/*.sql file once, in name order, each inside its own
// transaction. Applied files are recorded in app_schema_migrations, so running
// it again only applies new files. A transaction-level advisory lock keeps two
// instances starting at once (or two Vercel cold starts) from applying the same
// file twice; it also works through Supabase's transaction pooler.
export async function applyMigrations({ log = console.log } = {}) {
  const pool = getPool();
  const files = fs.readdirSync(sqlDir).filter((file) => file.endsWith('.sql')).sort();

  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query('COMMIT');

    for (const file of files) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
        const done = await client.query('SELECT 1 FROM app_schema_migrations WHERE filename = $1', [file]);
        if (done.rowCount) {
          await client.query('COMMIT');
          continue;
        }
        await client.query(fs.readFileSync(path.join(sqlDir, file), 'utf8'));
        // A file may record itself (012 does), hence ON CONFLICT.
        await client.query('INSERT INTO app_schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`Applied migration: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
  } finally {
    client.release();
  }
  return applied;
}

// Migrations run on start-up unless AUTO_MIGRATE=false.
export const autoMigrateEnabled = () => String(process.env.AUTO_MIGRATE || '').toLowerCase() !== 'false';
