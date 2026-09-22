import { buildLink } from './emailService.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `PHP ${amount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : 'Not specified';
}

function message(subject, text, html) {
  return { subject, text, html: `<div style="font-family:Arial,sans-serif;line-height:1.5">${html}</div>` };
}

export function passwordResetEmail({ username, token }) {
  const link = buildLink('/reset-password', token);
  const safeUsername = escapeHtml(username);
  return message(
    'Reset your ACIFAC password',
    `Hello ${username},\n\nUse this link to reset your password: ${link}\n\nThis link expires in 15 minutes.`,
    `<p>Hello ${safeUsername},</p><p>Use the link below to reset your password. It expires in 15 minutes.</p><p><a href="${link}">Reset password</a></p>`
  );
}

export function accountCreatedEmail({ memberName, username, token }) {
  const link = buildLink('/reset-password', token);
  return message(
    'Your ACIFAC account is ready',
    `Hello ${memberName},\n\nYour ACIFAC username is ${username}. Set your password here: ${link}\n\nThis link expires in 24 hours.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Your ACIFAC username is <strong>${escapeHtml(username)}</strong>.</p><p><a href="${link}">Set your password</a> (expires in 24 hours)</p>`
  );
}

export function loanSubmittedEmail({ memberName, memberNumber, amount, requestId }) {
  return message(
    'ACIFAC loan application received',
    `Loan application ${requestId} for ${memberName} (${memberNumber}) was submitted for ${formatAmount(amount)}.`,
    `<p>Loan application <strong>${escapeHtml(requestId)}</strong> for ${escapeHtml(memberName)} was received.</p><p>Requested amount: ${formatAmount(amount)}</p>`
  );
}

export function loanDecisionEmail({ memberName, requestId, amount, interestRate, term, status, reason }) {
  const decision = status === 'approved' ? 'approved' : 'declined';
  const details = status === 'approved'
    ? `Amount: ${formatAmount(amount)}\nInterest rate: ${interestRate ?? 'Not specified'}%\nTerm: ${term ?? 'Not specified'} months`
    : `Reason: ${reason || 'Please contact ACIFAC for more information.'}`;
  return message(
    `ACIFAC loan application ${decision}`,
    `Your loan application ${requestId} was ${decision}.\n\n${details}`,
    `<p>Your loan application <strong>${escapeHtml(requestId)}</strong> was <strong>${decision}</strong>.</p><p>${escapeHtml(details).replaceAll('\n', '<br>')}</p>`
  );
}

export function paymentEmail({ memberName, amount, paymentDate, loanNumber, remainingBalance, status }) {
  return message(
    'ACIFAC loan payment recorded',
    `Hello ${memberName}, your payment of ${formatAmount(amount)} for loan ${loanNumber} was recorded on ${paymentDate}. Remaining balance: ${formatAmount(remainingBalance)}.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Your payment of <strong>${formatAmount(amount)}</strong> for loan ${escapeHtml(loanNumber)} was recorded.</p><p>Remaining balance: ${formatAmount(remainingBalance)} (${escapeHtml(status)}).</p>`
  );
}