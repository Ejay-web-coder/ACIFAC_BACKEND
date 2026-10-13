// A short suggestion for the credit committee on lending to one member again,
// from how they repaid their loans: written by the AI from the repayment
// figures (never the member's name), or by the rules below when the AI is not
// set up or cannot answer. A suggestion to discuss, never a decision.
import { aiFailureReason, askAiText } from './aiClient.js';

export const VERDICTS = ['lend', 'caution', 'do_not_lend', 'no_history'];

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export const CREDIT_RULES = 'On time: an installment fully paid on or before its due date. Do not lend for now: 3 or more installments overdue, or under 50% paid on time. Lend with caution: any overdue installment, under 80% paid on time, or a restructured loan. Can lend: the rest. Not enough history: no installment has fallen due yet.';

/**
 * The member's repayment figures, from their loans and the installments
 * already due (oldest first): { loanId, dueDate, onTime, overdue, daysLate }.
 */
export function creditFacts({ loans, installments, shareCapital = 0, today }) {
  const late = installments.filter((item) => !item.onTime);
  const daysLate = late.map((item) => item.daysLate).filter((days) => days > 0);
  const onTime = installments.length - late.length;
  return {
    today,
    shareCapital,
    loans: {
      total: loans.length,
      open: loans.filter((loan) => loan.status === 'active' || loan.status === 'overdue').length,
      fullyPaid: loans.filter((loan) => loan.status === 'paid').length,
      restructured: loans.filter((loan) => loan.restructurings > 0).length,
      totalBorrowed: loans.reduce((sum, loan) => sum + loan.amount, 0),
      outstandingBalance: loans.filter((loan) => loan.status !== 'paid').reduce((sum, loan) => sum + loan.balance, 0),
    },
    installments: {
      due: installments.length,
      onTime,
      late: late.length,
      overdueNow: installments.filter((item) => item.overdue).length,
      onTimeRate: installments.length ? Math.round((onTime / installments.length) * 1000) / 10 : null,
      averageDaysLate: daysLate.length ? Math.round(daysLate.reduce((sum, days) => sum + days, 0) / daysLate.length) : 0,
      mostDaysLate: daysLate.length ? Math.max(...daysLate) : 0,
    },
    // The last 12 installments due, oldest first: how the member pays lately.
    recent: installments.slice(-12).map((item) => ({
      due: item.dueDate,
      result: item.onTime ? 'on time' : item.overdue ? `overdue, ${plural(item.daysLate, 'day')}` : `late, ${plural(item.daysLate, 'day')}`,
    })),
    perLoan: loans.map((loan) => {
      const own = installments.filter((item) => item.loanId === loan.id);
      return {
        amount: loan.amount, balance: loan.balance, status: loan.status, approved: loan.dateApproved,
        installmentsDue: own.length, onTime: own.filter((item) => item.onTime).length, late: own.filter((item) => !item.onTime).length,
        restructurings: loan.restructurings,
      };
    }),
  };
}

/** The rule-based suggestion (see CREDIT_RULES). */
export function ruleAdvice(facts) {
  const { installments: due, loans } = facts;
  if (due.due === 0) {
    return {
      verdict: 'no_history',
      suggestion: loans.total
        ? 'No installment has fallen due yet, so there is no repayment record to judge. Wait for a few payments before lending more.'
        : 'This member has not borrowed yet, so there is no repayment record. Judge a first loan on the application itself.',
      reasons: [],
    };
  }
  const reasons = [`${due.onTime} of ${plural(due.due, 'installment')} paid on time (${due.onTimeRate}%)`];
  if (due.late) reasons.push(`${plural(due.late, 'late installment')}${due.averageDaysLate ? `, ${plural(due.averageDaysLate, 'day')} late on average` : ''}`);
  if (due.overdueNow) reasons.push(`${plural(due.overdueNow, 'installment')} overdue now`);
  if (loans.restructured) reasons.push(`${plural(loans.restructured, 'loan')} restructured`);
  if (loans.fullyPaid) reasons.push(`${plural(loans.fullyPaid, 'loan')} fully paid`);

  if (due.overdueNow >= 3 || due.onTimeRate < 50) {
    return {
      verdict: 'do_not_lend',
      suggestion: `Do not lend to this member for now: only ${due.onTime} of ${plural(due.due, 'installment')} were paid on time${due.overdueNow ? ` and ${due.overdueNow} ${due.overdueNow === 1 ? 'is' : 'are'} overdue` : ''}. Ask them to settle what is due first.`,
      reasons: reasons.slice(0, 3),
    };
  }
  if (due.overdueNow > 0 || due.onTimeRate < 80 || loans.restructured > 0) {
    return {
      verdict: 'caution',
      suggestion: `Lend with caution: ${due.onTime} of ${plural(due.due, 'installment')} were paid on time${due.overdueNow ? ` and ${due.overdueNow} ${due.overdueNow === 1 ? 'is' : 'are'} overdue now` : ''}. Consider a smaller amount until the payments are regular.`,
      reasons: reasons.slice(0, 3),
    };
  }
  return {
    verdict: 'lend',
    suggestion: `Can lend again: ${due.onTime} of ${plural(due.due, 'installment')} were paid on time and nothing is overdue.`,
    reasons: reasons.slice(0, 3),
  };
}

const SYSTEM_PROMPT = `You help the credit committee of ACIFAC, a farmers' cooperative in the Philippines, decide whether to lend to a member again.
You get one member's loan repayment figures as JSON (no name). "recent" lists their last installments due, oldest first.
Answer with JSON: {"verdict": one of "lend", "caution", "do_not_lend", "no_history", "suggestion": string, "reasons": [up to 3 short strings]}.
Rules:
- "suggestion" is one or two plain sentences, at most 40 words, telling the committee what to do and why, e.g. "Do not lend to this member anymore: 7 of 9 monthly installments were paid late and 3 are overdue."
- Judge how they pay: on time or late, how late, whether it is getting better or worse lately, overdue installments, restructured loans, loans fully paid.
- Quote the figures behind it (amounts in PHP written like ₱12,500). Use only the figures given; never invent any.
- When no installment has fallen due yet, the verdict is "no_history".
- Say "this member", never a name. It is advice for the committee, not a decision.`;

function cleanAdvice(answer) {
  const verdict = VERDICTS.includes(answer?.verdict) ? answer.verdict : null;
  const suggestion = text(answer?.suggestion, 400);
  if (!verdict || !suggestion) return null;
  const reasons = (Array.isArray(answer?.reasons) ? answer.reasons : []).map((reason) => text(reason, 160)).filter(Boolean).slice(0, 3);
  return { verdict, suggestion, reasons };
}

/** The suggestion for one member: the AI's, else the rule-based one with the reason. */
export async function adviseOnCredit(facts) {
  const base = { generatedAt: new Date().toISOString(), methodology: CREDIT_RULES };
  const fallback = (notice) => ({ ...base, source: 'rules', ...ruleAdvice(facts), notice });
  if (facts.installments.due === 0) return { ...base, source: 'rules', ...ruleAdvice(facts), notice: '' };
  if (!process.env.GEMINI_API_KEY && !process.env.OCR_AI_API_KEY && !process.env.OPENAI_API_KEY) {
    return fallback('AI is not set up on the server, so this is the rule-based suggestion.');
  }
  try {
    const advice = cleanAdvice(await askAiText(SYSTEM_PROMPT, `This member's loan repayment figures:\n${JSON.stringify(facts)}`));
    if (!advice) return fallback('The AI gave no usable suggestion, so this is the rule-based one.');
    return { ...base, source: 'ai', ...advice, notice: '' };
  } catch (error) {
    console.warn('Credit advice: AI failed:', error instanceof Error ? error.message : error);
    return fallback(`AI could not answer (${aiFailureReason(error)}), so this is the rule-based suggestion.`);
  }
}
