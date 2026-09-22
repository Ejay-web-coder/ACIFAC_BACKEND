import nodemailer from 'nodemailer';

const emailUser = process.env.EMAIL_USER || process.env.SMTP_USER;
const emailPassword = process.env.EMAIL_APP_PASSWORD || process.env.SMTP_PASSWORD;
const emailFrom = process.env.EMAIL_FROM || emailUser;
const emailHost = process.env.EMAIL_HOST || process.env.SMTP_HOST;
const emailPort = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 587);
const emailSecure = String(process.env.EMAIL_SECURE || process.env.SMTP_SECURE || (emailPort === 465)).toLowerCase() === 'true';
const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173';

const transporter = emailHost && emailUser && emailPassword
  ? nodemailer.createTransport({ host: emailHost, port: emailPort, secure: emailSecure, auth: { user: emailUser, pass: emailPassword } })
  : null;

function buildLink(path, token) {
  return `${appUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

export async function sendEmail({ to, subject, text, html }) {
  if (!transporter || !emailFrom) {
    console.warn('Email service is not configured; skipping email delivery.');
    return { sent: false, skipped: true };
  }

  await transporter.sendMail({ from: emailFrom, to, subject, text, html });
  return { sent: true };
}

export async function sendEmailSafely({ to, subject, text, html }) {
  if (!to) return { sent: false, skipped: true };

  try {
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

export { buildLink };