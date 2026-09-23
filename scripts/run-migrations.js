import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../src/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlDir = path.join(__dirname, '..', 'sql');

// Applies every sql/*.sql file once, in name order, each inside its own
// transaction. Applied files are recorded in app_schema_migrations so the
// command is safe to run repeatedly against the production database.
async function runMigrations() {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const applied = new Set((await pool.query('SELECT filename FROM app_schema_migrations')).rows.map((row) => row.filename));
  const files = fs.readdirSync(sqlDir).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping already applied migration: ${file}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(sqlDir, file), 'utf8'));
      await client.query('INSERT INTO app_schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [file]);
      await client.query('COMMIT');
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }

  console.log('All migrations applied.');
  await pool.end();
}

runMigrations().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
