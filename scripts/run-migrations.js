import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { query } from '../src/config/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlDir = path.join(__dirname, '..', 'sql');

async function runMigrations() {
  const files = fs.readdirSync(sqlDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(sqlDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    await query(sql);
    console.log(`Applied migration: ${file}`);
  }

  console.log('All migrations applied.');
  process.exit(0);
}

runMigrations().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
