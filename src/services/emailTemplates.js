import { getFrontendUrl } from '../config/env.js';
import { buildLink } from './emailService.js';
import { formatDateOnly } from '../utils/dates.js';

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

// repayment 'single': the whole amount is due by dueDate (YYYY-MM-DD), payable in parts; otherwise in monthly installments.
// A loan's interest_rate is its rate for the whole term. Loans under the
// current policy (2.5% a month for 6 months = 15%) say so per month.
function interestText(interestRate, term) {
  if (interestRate === null || interestRate === undefined || interestRate === '') return 'Not specified';
  const rate = Number(interestRate);
  if (term && Number(term) === 6 && rate === 15) return `2.5% of principal a month for ${term} months (${rate}% in all)`;
  return `${rate}% of principal (flat)`;
}

export function loanDecisionEmail({ requestId, amount, interestRate, term, status, reason, totalRepayment, monthlyPayment, repayment = 'monthly', dueDate = null, penaltyPerDay = 0, graceDays = 0 }) {
  const decision = status === 'approved' ? 'approved' : 'declined';
  // The late penalty: after a grace period past the due date, so much a day until paid in full.
  const late = Number(penaltyPerDay) > 0 ? `\nLate payment: after a ${graceDays}-day grace period, a penalty of ${formatAmount(penaltyPerDay)} a day until paid in full` : '';
  const payment = repayment === 'single'
    ? `Payment: the whole ${formatAmount(totalRepayment)}, due${dueDate ? ` by ${formatDateOnly(dueDate)}` : ''}${late}`
    : `Monthly installment: ${formatAmount(monthlyPayment)}`;
  const details = status === 'approved'
    ? `Amount: ${formatAmount(amount)}\nInterest: ${interestText(interestRate, term)}\nTotal repayment: ${formatAmount(totalRepayment)}\n${payment}\nTerm: ${term ?? 'Not specified'} months`
    : `Reason: ${reason || 'Please contact ACIFAC for more information.'}`;
  return message(
    `ACIFAC loan application ${decision}`,
    `Your loan application ${requestId} was ${decision}.\n\n${details}`,
    `<p>Your loan application <strong>${escapeHtml(requestId)}</strong> was <strong>${decision}</strong>.</p><p>${escapeHtml(details).replaceAll('\n', '<br>')}</p>`
  );
}

// penaltyPaid: the part of the payment that paid the late penalty, if any.
export function paymentEmail({ memberName, amount, paymentDate, loanNumber, remainingBalance, status, penaltyPaid = 0 }) {
  const penalty = Number(penaltyPaid) > 0 ? ` (${formatAmount(penaltyPaid)} of it for the late penalty)` : '';
  return message(
    'ACIFAC loan payment recorded',
    `Hello ${memberName}, your payment of ${formatAmount(amount)} for loan ${loanNumber} was recorded on ${paymentDate}${penalty}. Remaining balance: ${formatAmount(remainingBalance)}.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Your payment of <strong>${formatAmount(amount)}</strong> for loan ${escapeHtml(loanNumber)} was recorded${penalty}.</p><p>Remaining balance: ${formatAmount(remainingBalance)} (${escapeHtml(status)}).</p>`
  );
}
// Approved: the rental fee. Declined: the reason the office gave.
export function rentalDecisionEmail({ machineryName, startDate, endDate, status, rentalFee, reason = '' }) {
  const decision = status === 'approved' ? 'approved' : 'declined';
  const request = `Your rental request for ${machineryName} (${formatDateOnly(startDate)} to ${formatDateOnly(endDate)}) was ${decision}.`;
  const requestHtml = `Your rental request for <strong>${escapeHtml(machineryName)}</strong> (${escapeHtml(formatDateOnly(startDate))} to ${escapeHtml(formatDateOnly(endDate))}) was <strong>${decision}</strong>.`;
  if (decision === 'approved') {
    return message(
      'ACIFAC machinery rental approved',
      `${request} Rental fee: ${formatAmount(rentalFee)}.`,
      `<p>${requestHtml}</p><p>Rental fee: ${formatAmount(rentalFee)}</p>`
    );
  }
  const why = reason || 'Please contact ACIFAC for more information.';
  return message(
    'ACIFAC machinery rental declined',
    `${request}\n\nReason: ${why}\n\nYou can send a new request for other days under Rental Booking in the member portal, or ask the ACIFAC office.`,
    `<p>${requestHtml}</p><p><strong>Reason:</strong> ${escapeHtml(why).replaceAll('\n', '<br>')}</p><p>You can send a new request for other days under <strong>Rental Booking</strong> in the member portal, or ask the ACIFAC office.</p>`
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
    `Hello ${memberName},\n\nA share capital contribution of ${formatAmount(amount)} was recorded on ${date}.\nYour total share capital is now ${formatAmount(total)}. The most you can hold right now is ${formatAmount(maximum)} (10% of the cooperative's total share capital).`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>A share capital contribution of <strong>${formatAmount(amount)}</strong> was recorded on ${escapeHtml(date)}.</p><p>Your total share capital is now <strong>${formatAmount(total)}</strong>. The most you can hold right now is ${formatAmount(maximum)} (10% of the cooperative's total share capital).</p>`
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

export function membershipTerminatedEmail({ memberName, memberNumber, kind, date }) {
  return message(
    'Your ACIFAC membership was terminated',
    `Hello ${memberName},\n\nYour membership in ACIFAC (${memberNumber}) was terminated on ${formatDateOnly(date)} (${kind}).\nIf you think this is a mistake, or for your share capital and savings, please visit the ACIFAC office.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Your membership in ACIFAC (<strong>${escapeHtml(memberNumber)}</strong>) was terminated on ${escapeHtml(formatDateOnly(date))} (${escapeHtml(kind)}).</p><p>If you think this is a mistake, or for your share capital and savings, please visit the ACIFAC office.</p>`
  );
}

export function membershipRestoredEmail({ memberName, memberNumber }) {
  return message(
    'Your ACIFAC membership was restored',
    `Hello ${memberName},\n\nYour membership in ACIFAC (${memberNumber}) was restored. You are an active member again.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Your membership in ACIFAC (<strong>${escapeHtml(memberNumber)}</strong>) was restored. You are an active member again.</p>`
  );
}

export function duesReminderEmail({ memberName, total, count, oldest }) {
  return message(
    'ACIFAC: unpaid dues',
    `Hello ${memberName},\n\nYou have ${count} unpaid ${count === 1 ? 'due' : 'dues'} totalling ${formatAmount(total)}, the oldest from ${formatDateOnly(oldest)}.\nPlease pay them at the ACIFAC office. You can see them in the member portal under Dues.`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>You have ${count} unpaid ${count === 1 ? 'due' : 'dues'} totalling <strong>${formatAmount(total)}</strong>, the oldest from ${escapeHtml(formatDateOnly(oldest))}.</p><p>Please pay them at the ACIFAC office. You can see them in the member portal under <strong>Dues</strong>.</p>`
  );
}

export function machineryPaymentEmail({ memberName, amount, paymentDate, serviceType, machineryName, serviceDate, balance, voided = false }) {
  const work = `${serviceType} by ${machineryName} on ${formatDateOnly(serviceDate)}`;
  const left = Number(balance) > 0 ? `Balance: ${formatAmount(balance)}.` : 'The fee is fully paid.';
  return voided
    ? message(
      'ACIFAC machinery payment cancelled',
      `Hello ${memberName},\n\nThe ${formatAmount(amount)} payment of ${formatDateOnly(paymentDate)} for ${work} was cancelled by the office.\n${left}`,
      `<p>Hello ${escapeHtml(memberName)},</p><p>The <strong>${formatAmount(amount)}</strong> payment of ${escapeHtml(formatDateOnly(paymentDate))} for ${escapeHtml(work)} was cancelled by the office.</p><p>${escapeHtml(left)}</p>`
    )
    : message(
      'ACIFAC machinery payment recorded',
      `Hello ${memberName},\n\nA payment of ${formatAmount(amount)} for ${work} was recorded on ${formatDateOnly(paymentDate)}.\n${left}\nYou can see it under Transactions in the member portal.`,
      `<p>Hello ${escapeHtml(memberName)},</p><p>A payment of <strong>${formatAmount(amount)}</strong> for ${escapeHtml(work)} was recorded on ${escapeHtml(formatDateOnly(paymentDate))}.</p><p>${escapeHtml(left)} You can see it under <strong>Transactions</strong> in the member portal.</p>`
    );
}

// --- Sent to many members at once (memberEmails.emailInBulk) --------------------
// The same message goes to everyone, so none of these greets by name.

const portal = () => getFrontendUrl();
const bulkFooter = () => `You get these emails as an ACIFAC member. To stop them, turn off Email Notifications under Settings in the member portal (${portal()}).`;
const bulkFooterHtml = () => `<p style="margin-top:24px;font-size:12px;color:#6b7280">You get these emails as an ACIFAC member. To stop them, turn off Email Notifications under Settings in the <a href="${escapeHtml(portal())}">member portal</a>.</p>`;
// Web addresses in escaped text become links (without a full stop or bracket that ends the sentence).
const linkify = (html) => html.replace(/https?:\/\/[^\s<]+/g, (url) => {
  const address = url.replace(/[.,;:!?)]+$/, '');
  return `<a href="${address}">${address}</a>${url.slice(address.length)}`;
});
const paragraphsHtml = (text) => String(text).split(/\n{2,}/).map((part) => `<p>${linkify(escapeHtml(part)).replaceAll('\n', '<br>')}</p>`).join('');

// An announcement posted by the office. `postedOn` is YYYY-MM-DD; `postedBy` may be empty.
export function announcementEmail({ title, message: body, postedOn, postedBy = '' }) {
  const posted = `Posted on ${formatDateOnly(postedOn)}${postedBy ? ` by ${postedBy}` : ''}.`;
  return message(
    `ACIFAC announcement: ${title}`,
    `ACIFAC announcement\n\n${title}\n\n${body}\n\n${posted}\n\n${bulkFooter()}`,
    `<p style="margin:0;font-size:12px;font-weight:bold;letter-spacing:1px;color:#15803d">ACIFAC ANNOUNCEMENT</p><h2 style="margin:4px 0 12px">${escapeHtml(title)}</h2>${paragraphsHtml(body)}<p style="color:#6b7280">${escapeHtml(posted)}</p>${bulkFooterHtml()}`
  );
}

// An activity members must attend: created, changed (its day, time or place)
// or cancelled. `noun` is "meeting" or "activity"; `when` is "December 5,
// 2026, 8:00 AM to 12:00 PM"; `note` says who must attend and what to bring;
// `date` (YYYY-MM-DD) and `reason` are for a cancellation.
export function activityEmail({ change, noun, title, when, venue, organizer = '', description = '', note = '', date, reason = '' }) {
  const link = `${portal()}/member/attendance`;
  const details = [`When: ${when}`, `Where: ${venue}`, organizer ? `Organized by: ${organizer}` : ''].filter(Boolean).join('\n');
  const opening = {
    created: `ACIFAC has a new ${noun}: ${title}.`,
    changed: `The ${noun} "${title}" was changed. It is now:`,
    cancelled: `The ${noun} "${title}" on ${formatDateOnly(date)} was cancelled.${reason ? `\nReason: ${reason}` : ''}`,
  }[change];
  const subject = { created: `ACIFAC ${noun}: ${title}`, changed: `ACIFAC ${noun} changed: ${title}`, cancelled: `ACIFAC ${noun} cancelled: ${title}` }[change];
  const parts = change === 'cancelled'
    ? [opening]
    : [opening, details, change === 'created' ? description : '', note, `You can see it under Attendance in the member portal: ${link}`];
  const text = ['Hello,', ...parts.filter(Boolean)].join('\n\n');
  return message(subject, `${text}\n\n${bulkFooter()}`, `${paragraphsHtml(text)}${bulkFooterHtml()}`);
}

export function loyaltyMilestoneEmail({ memberName, years, award }) {
  return message(
    `ACIFAC: ${years} years as a member`,
    `Hello ${memberName},\n\nCongratulations! Today you have been a member of ACIFAC for ${years} years. Thank you for your loyalty.${award ? `\nMembers in good standing (regular attendance and loan payments on time) receive the ${award} at the General Assembly.` : ''}`,
    `<p>Hello ${escapeHtml(memberName)},</p><p>Congratulations! Today you have been a member of ACIFAC for <strong>${escapeHtml(years)} years</strong>. Thank you for your loyalty.</p>${award ? `<p>Members in good standing (regular attendance and loan payments on time) receive the <strong>${escapeHtml(award)}</strong> at the General Assembly.</p>` : ''}`
  );
}
