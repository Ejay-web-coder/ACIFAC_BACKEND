import nodemailer from 'nodemailer';
import { query } from '../config/db.js';
import { getFrontendUrl } from '../config/env.js';

// SMTP configuration comes only from environment variables. EMAIL_* names are
// preferred; SMTP_* are accepted for backwards compatibility.
const emailUser = process.env.EMAIL_USER || process.env.SMTP_USER;
const emailPassword = process.env.EMAIL_APP_PASSWORD || process.env.SMTP_PASSWORD;
const emailFrom = process.env.EMAIL_FROM || emailUser;
const emailHost = process.env.EMAIL_HOST || process.env.SMTP_HOST;
const emailPort = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 587);
const emailSecure = String(process.env.EMAIL_SECURE || process.env.SMTP_SECURE || (emailPort === 465)).toLowerCase() === 'true';

let transporter = emailHost && emailUser && emailPassword
  ? nodemailer.createTransport({ host: emailHost, port: emailPort, secure: emailSecure, auth: { user: emailUser, pass: emailPassword } })
  : null;

export function isEmailConfigured() {
  return Boolean(transporter && emailFrom);
}

// Test hook: lets integration tests capture outgoing mail without SMTP.
export function setEmailTransportForTesting(testTransport) {
  transporter = testTransport;
}

export function buildLink(path, token) {
  return `${getFrontendUrl()}${path}?token=${encodeURIComponent(token)}`;
}

export async function sendEmail({ to, subject, text, html }) {
  if (!isEmailConfigured()) {
    console.warn('Email service is not configured; skipping email delivery.');
    return { sent: false, skipped: true };
  }
  await transporter.sendMail({ from: emailFrom || 'acifac@localhost', to, subject, text, html });
  return { sent: true };
}

async function userAllowsEmail(userId) {
  if (!userId) return true;
  const result = await query(`SELECT notification_preferences FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.notification_preferences?.emailNotifications !== false;
}

// Never throws: email is sent after the database transaction has committed, so
// a delivery failure cannot undo or corrupt the recorded change.
// `essential` emails (account setup, password reset) ignore the opt-out.
export async function sendEmailSafely({ to, subject, text, html, relatedUserId = null, essential = false }) {
  if (!to) return { sent: false, skipped: true };
  try {
    if (!essential && !(await userAllowsEmail(relatedUserId))) return { sent: false, skipped: true };
    return await sendEmail({ to, subject, text, html });
  } catch (error) {
    console.error('Email delivery error:', error instanceof Error ? error.message : error);
    return { sent: false, error };
  }
}

export async function sendTestEmail(recipient) {
  return sendEmail({
    to: recipient,
    subject: 'ACIFAC email service test',
    text: 'This is a test email from ACIFAC.',
    html: '<p>This is a test email from ACIFAC.</p>',
  });
}
