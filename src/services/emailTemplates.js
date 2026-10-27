import { getFrontendUrl } from '../config/env.js';
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

export function passwordResetEmail({ name, token, expiresIn = '15 minutes' }) {
  const link = buildLink('/reset-password', token);
  const safeName = escapeHtml(name);
  return message(
    'Reset your ACIFAC password',
    `Hello ${name},\n\nUse this link to reset your password: ${link}\n\nThis link expires in ${expiresIn}. If you did not request it, you can ignore this email.`,
    `<p>Hello ${safeName},</p><p>Use the link below to reset your password. It expires in ${escapeHtml(expiresIn)}.</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`
  );
}

// The code is only ever in this email and its text message (smsService.js):
// never in a link, log or response.
export function passwordResetCodeEmail({ code, expiresInMinutes = 10 }) {
  return message(
    'ACIFAC Password Reset',
    `ACIFAC Password Reset\n\nYour verification code is:\n\n${code}\n\nThis code expires in ${expiresInMinutes} minutes.\n\nIf you did not request a password reset, you can ignore this email.`,
    `<h2 style="margin:0 0 12px">ACIFAC Password Reset</h2><p>Your verification code is:</p><p style="margin:8px 0;font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(code)}</p><p>This code expires in ${escapeHtml(expiresInMinutes)} minutes.</p><p>If you did not request a password reset, you can ignore this email.</p>`
  );
}

// Proves that a new administrator's email reaches them, while an administrator
// makes their account in Manage Users. Like the reset code, it is only ever here.
export function adminContactCodeEmail({ code, name, expiresInMinutes = 10 }) {
  return message(
    'ACIFAC administrator account: verify your email',
    `Hello ${name},\n\nAn ACIFAC administrator is making an administrator account for you with this email. Give them this verification code:\n\n${code}\n\nThis code expires in ${expiresInMinutes} minutes. If you did not expect this, ignore this email.`,
    `<p>Hello ${escapeHtml(name)},</p><p>An ACIFAC administrator is making an administrator account for you with this email. Give them this verification code:</p><p style="margin:8px 0;font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(code)}</p><p>This code expires in ${escapeHtml(expiresInMinutes)} minutes. If you did not expect this, ignore this email.</p>`
  );
}

// The new administrator's welcome: who made the account and how to sign in. The temporary password is never in it.
export function adminAccountCreatedEmail({ name, position, username, createdBy }) {
  const link = `${getFrontendUrl()}/login`;
  return message(
    'Your ACIFAC administrator account is ready',
    `Hello ${name},\n\n${createdBy} made an ACIFAC administrator account for you as ${position}.\n\nSign in at ${link} with your username (${username}), this email or your mobile number, and the temporary password they gave you. You will be asked to choose your own password.\n\nEverything you do in the system is recorded in the audit log under your name and position.`,
    `<p>Hello ${escapeHtml(name)},</p><p>${escapeHtml(createdBy)} made an ACIFAC administrator account for you as <strong>${escapeHtml(position)}</strong>.</p><p><a href="${escapeHtml(link)}">Sign in</a> with your username (<strong>${escapeHtml(username)}</strong>), this email or your mobile number, and the temporary password they gave you. You will be asked to choose your own password.</p><p>Everything you do in the system is recorded in the audit log under your name and position.</p>`
  );
}

// The member signs in with this email, or the mobile number (masked) when it is theirs alone.
export function accountCreatedEmail({ memberName, email, phone, token }) {
  const link = buildLink('/reset-password', token);
  const signIn = phone ? `your email (${email}) or your mobile number (${phone})` : `your email (${email})`;
  return message(
    'Your ACIFAC account is ready',
    `Hello ${memberName},\n\nSign in to ACIFAC with ${signIn}. Set your password here: ${link}\n\nThis link expires in 24 hours.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Sign in to ACIFAC with ${escapeHtml(signIn)}.</p><p><a href="${escapeHtml(link)}">Set your password</a> (expires in 24 hours)</p>`
  );
}

export function loanSubmittedEmail({ memberName, memberNumber, amount, requestId }) {
  return message(
    'ACIFAC loan application received',
    `Loan application ${requestId} for ${memberName} (${memberNumber}) was submitted for ${formatAmount(amount)}.`,
    `<p>Loan application <strong>${escapeHtml(requestId)}</strong> for ${escapeHtml(memberName)} was received.</p><p>Requested amount: ${formatAmount(amount)}</p>`
  );
}

export function loanDecisionEmail({ requestId, amount, interestRate, term, status, reason, totalRepayment, monthlyPayment }) {
  const decision = status === 'approved' ? 'approved' : 'declined';
  const details = status === 'approved'
    ? `Amount: ${formatAmount(amount)}\nInterest: ${interestRate ?? 'Not specified'}% of principal (flat)\nTotal repayment: ${formatAmount(totalRepayment)}\nMonthly installment: ${formatAmount(monthlyPayment)}\nTerm: ${term ?? 'Not specified'} months`
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
export function rentalDecisionEmail({ machineryName, startDate, endDate, status, rentalFee }) {
  const decision = status === 'approved' ? 'approved' : 'declined';
  return message(
    `ACIFAC machinery rental ${decision}`,
    `Your rental request for ${machineryName} (${startDate} to ${endDate}) was ${decision}. Rental fee: ${formatAmount(rentalFee)}.`,
    `<p>Your rental request for <strong>${escapeHtml(machineryName)}</strong> (${escapeHtml(startDate)} to ${escapeHtml(endDate)}) was <strong>${decision}</strong>.</p><p>Rental fee: ${formatAmount(rentalFee)}</p>`
  );
}

// --- Member activity ------------------------------------------------------------
// `fromPaperForm` marks records the OCR scanner created from a scanned form.
const paperNote = (fromPaperForm) => (fromPaperForm ? ' It was recorded from your paper form.' : '');

export function savingsDepositEmail({ memberName, amount, date, reference, total, fromPaperForm = false }) {
  return message(
    'ACIFAC savings deposit recorded',
    `Hello ${memberName},\n\nA savings deposit of ${formatAmount(amount)} was recorded on ${date}${reference ? ` (reference ${reference})` : ''}.${paperNote(fromPaperForm)}\nYour total savings are now ${formatAmount(total)}.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>A savings deposit of <strong>${formatAmount(amount)}</strong> was recorded on ${escapeHtml(date)}${reference ? ` (reference ${escapeHtml(reference)})` : ''}.${escapeHtml(paperNote(fromPaperForm))}</p><p>Your total savings are now <strong>${formatAmount(total)}</strong>.</p>`
  );
}

export function savingsWithdrawalEmail({ memberName, amount, date, reference, total }) {
  return message(
    'ACIFAC savings withdrawal recorded',
    `Hello ${memberName},\n\nA savings withdrawal of ${formatAmount(amount)} was recorded on ${date}${reference ? ` (reference ${reference})` : ''}.\nYour total savings are now ${formatAmount(total)}.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>A savings withdrawal of <strong>${formatAmount(amount)}</strong> was recorded on ${escapeHtml(date)}${reference ? ` (reference ${escapeHtml(reference)})` : ''}.</p><p>Your total savings are now <strong>${formatAmount(total)}</strong>.</p>`
  );
}

export function shareContributionEmail({ memberName, amount, date, total, maximum }) {
  return message(
    'ACIFAC share capital contribution recorded',
    `Hello ${memberName},\n\nA share capital contribution of ${formatAmount(amount)} was recorded on ${date}.\nYour total share capital is now ${formatAmount(total)} of the ${formatAmount(maximum)} maximum.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>A share capital contribution of <strong>${formatAmount(amount)}</strong> was recorded on ${escapeHtml(date)}.</p><p>Your total share capital is now <strong>${formatAmount(total)}</strong> of the ${formatAmount(maximum)} maximum.</p>`
  );
}

export function loanApplicationReceivedEmail({ memberName, requestId, amount, loanType, term, fromPaperForm = false }) {
  return message(
    'ACIFAC received your loan application',
    `Hello ${memberName},\n\nWe received your ${loanType} loan application #${requestId} for ${formatAmount(amount)} (${term} months).${paperNote(fromPaperForm)}\nThe cooperative will review it and email you the decision.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>We received your ${escapeHtml(loanType)} loan application <strong>#${escapeHtml(requestId)}</strong> for <strong>${formatAmount(amount)}</strong> (${escapeHtml(term)} months).${escapeHtml(paperNote(fromPaperForm))}</p><p>The cooperative will review it and email you the decision.</p>`
  );
}

export function loanReminderEmail({ title, message: body }) {
  return message(
    `ACIFAC: ${title}`,
    `${body}\n\nPlease settle it at the ACIFAC office. You can see your loan schedule in the member portal under Loan Status.`,
    `<p>${escapeHtml(body)}</p><p>Please settle it at the ACIFAC office. You can see your loan schedule in the member portal under <strong>Loan Status</strong>.</p>`
  );
}

export function rentalRequestReceivedEmail({ memberName, machineryName, startDate, endDate, rentalFee, fromPaperForm = false }) {
  return message(
    'ACIFAC received your machinery rental request',
    `Hello ${memberName},\n\nWe received your request to rent ${machineryName} from ${startDate} to ${endDate} (rental fee ${formatAmount(rentalFee)}).${paperNote(fromPaperForm)}\nYou will get another email when it is approved or declined.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>We received your request to rent <strong>${escapeHtml(machineryName)}</strong> from ${escapeHtml(startDate)} to ${escapeHtml(endDate)} (rental fee ${formatAmount(rentalFee)}).${escapeHtml(paperNote(fromPaperForm))}</p><p>You will get another email when it is approved or declined.</p>`
  );
}

export function welcomeMemberEmail({ memberName, memberNumber, membershipDate, fromPaperForm = false }) {
  return message(
    'Welcome to ACIFAC',
    `Hello ${memberName},\n\nWelcome to the Amnay-Cabagan Irrigators and Farmers Agriculture Cooperative. Your member number is ${memberNumber}, effective ${membershipDate}.${paperNote(fromPaperForm)}\nKeep this number for loans, savings and machinery rentals.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Welcome to the Amnay-Cabagan Irrigators and Farmers Agriculture Cooperative. Your member number is <strong>${escapeHtml(memberNumber)}</strong>, effective ${escapeHtml(membershipDate)}.${escapeHtml(paperNote(fromPaperForm))}</p><p>Keep this number for loans, savings and machinery rentals.</p>`
  );
}
