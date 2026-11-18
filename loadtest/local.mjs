// Runs the backend (or the seeder) against a LOCAL database for load testing.
//
//   node loadtest/local.mjs seed      migrate and fill the database with sample data
//                                     (admin + member001 ... member100); add
//                                     --add-members=300 for more member logins
//   node loadtest/local.mjs server    start the backend on port 4001
//
// The database comes from LOADTEST_DB_URL, which must point at this computer:
//   PowerShell: $env:LOADTEST_DB_URL='postgres://postgres:PASSWORD@localhost:5432/acifac_loadtest'
//
// ACIFAC_BACKEND/.env holds the live Supabase database, storage, AI, e-mail and
// SMS settings, and dotenv fills in every variable that is not already set. So
// each of them is set here first (an empty string counts as set; dotenv never
// overrides it), and nothing from a load test can reach the live system.
// Setting them to '' in PowerShell does not work: that deletes the variable.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const command = process.argv[2];
const databaseUrl = process.env.LOADTEST_DB_URL;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!['seed', 'server'].includes(command)) fail('Use: node loadtest/local.mjs seed | server');
if (!databaseUrl) {
  fail('Set LOADTEST_DB_URL to a database on this computer, for example\n'
    + "  $env:LOADTEST_DB_URL='postgres://postgres:PASSWORD@localhost:5432/acifac_loadtest'");
}
let host = '';
try { host = new URL(databaseUrl).hostname; } catch { fail('LOADTEST_DB_URL is not a valid connection string.'); }
if (!LOCAL_HOSTS.has(host)) fail(`Refusing to run against ${host}: load tests only run on a database on this computer.`);

Object.assign(process.env, {
  NODE_ENV: 'development',
  PORT: process.env.LOADTEST_PORT || '4001',
  SUPABASE_DB_URL: databaseUrl,
  DATABASE_URL: databaseUrl,
  SUPABASE_DB_LISTEN_URL: databaseUrl,
  DATABASE_SSL: 'disable',
  DATABASE_SSL_CA: '',
  // A real deployment's pool size; raise it to see whether the pool is the limit.
  DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX || '10',
  // k6 sends every virtual user from this one address, so the per-address
  // limit (600 a minute) would answer 429 long before the server is busy.
  API_RATE_LIMIT_PER_MINUTE: process.env.API_RATE_LIMIT_PER_MINUTE || '1000000',
  CORS_ORIGIN: 'http://localhost:5174',
  FRONTEND_URL: 'http://localhost:5174',
  COOKIE_SAMESITE: 'lax',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  GEMINI_API_KEY: '',
  OCR_AI_API_KEY: '',
  OCR_AI_URL: '',
  EMAIL_HOST: '',
  EMAIL_USER: '',
  EMAIL_APP_PASSWORD: '',
  EMAIL_FROM: '',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  SMTP_FROM: '',
  TEXTBEE_API_KEY: '',
  TEXTBEE_DEVICE_ID: '',
  CRON_SECRET: '',
});

if (command === 'seed') await import('../scripts/seed.js');
else await import('../src/server.js');
