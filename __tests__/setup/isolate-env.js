// Runs before every test file. The local .env points at the live database and
// at the real email, SMS and AI accounts. Every outside connection is blanked
// here first: dotenv never overwrites a variable that is already set, so a unit
// test can never reach production. Anything that needs the database is mocked.
const BLANK = [
  'SUPABASE_DB_URL', 'DATABASE_URL', 'SUPABASE_DB_LISTEN_URL', 'DATABASE_SSL_CA', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_SECURE', 'EMAIL_USER', 'EMAIL_APP_PASSWORD', 'EMAIL_FROM',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASSWORD', 'SMTP_FROM',
  'TEXTBEE_API_KEY', 'TEXTBEE_DEVICE_ID', 'TEXTBEE_API_URL',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_API_BASE', 'OPENAI_API_KEY', 'OCR_AI_API_KEY', 'OCR_AI_URL', 'OCR_AI_MODEL',
  'CORS_ORIGIN', 'FRONTEND_URL', 'APP_URL', 'COOKIE_SAMESITE', 'SESSION_SECRET', 'COOKIE_SECRET', 'JWT_SECRET', 'RESET_TOKEN_SECRET',
  'LOAN_PAYMENT_HOURS', 'SMS_SEND_HOURS', 'OCR_AUTO_POST', 'AUTO_MIGRATE', 'CRON_SECRET', 'PORT',
];
for (const name of BLANK) process.env[name] = '';
process.env.NODE_ENV = 'test';
process.env.ACIFAC_TIME_ZONE = 'Asia/Manila';
process.env.DISABLE_LIVE_UPDATES = 'true';
