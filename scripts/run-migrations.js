import { getPool } from '../src/config/db.js';
import { applyMigrations } from '../src/services/migrations.js';

// Manual run of the same migrations the server applies on start-up
// (src/services/migrations.js). Safe to run repeatedly.
applyMigrations()
  .then(async (applied) => {
    console.log(applied.length ? 'All migrations applied.' : 'Database is up to date.');
    await getPool().end();
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
