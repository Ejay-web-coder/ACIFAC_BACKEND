// Unit tests for the credit suggestion rules and the repayment figures (no database, no AI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseOnCredit, creditFacts, ruleAdvice } from '../src/services/creditAdvice.js';

const loan = (id, overrides = {}) => ({ id, amount: 10000, balance: 0, status: 'paid', dateApproved: '2025-01-10', restructurings: 0, ...overrides });
// One installment per month from January, on time unless listed late or overdue.
function installments(count, { late = [], overdue = [], loanId = 1, daysLate = 10 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const month = index + 1;
    const isOverdue = overdue.includes(month);
    const isLate = isOverdue || late.includes(month);
    return { loanId, dueDate: `2026-${String(month).padStart(2, '0')}-10`, onTime: !isLate, overdue: isOverdue, daysLate: isLate ? daysLate : 0 };
  });
}
const facts = (options) => creditFacts({ today: '2026-10-14', shareCapital: 5000, ...options });

test('figures: on-time rate, late and overdue counts, days late, recent payments', () => {
  const result = facts({ loans: [loan(1, { status: 'active', balance: 6000 })], installments: installments(9, { late: [2, 5], overdue: [9], daysLate: 12 }) });
  assert.deepEqual(result.installments, { due: 9, onTime: 6, late: 3, overdueNow: 1, onTimeRate: 66.7, averageDaysLate: 12, mostDaysLate: 12 });
  assert.deepEqual(result.loans, { total: 1, open: 1, fullyPaid: 0, restructured: 0, totalBorrowed: 10000, outstandingBalance: 6000 });
  assert.deepEqual(result.recent.slice(-2), [{ due: '2026-08-10', result: 'on time' }, { due: '2026-09-10', result: 'overdue, 12 days' }]);
  assert.equal(result.perLoan[0].late, 3);
  // No name or member number is in what is sent to the AI.
  assert.ok(!('name' in result) && !('memberNumber' in result));
});

test('pays on time and has a paid loan: can lend', () => {
  const advice = ruleAdvice(facts({ loans: [loan(1)], installments: installments(10) }));
  assert.equal(advice.verdict, 'lend');
  assert.match(advice.suggestion, /^Can lend again: 10 of 10 installments were paid on time/);
});

test('some late payments, an overdue one or a restructured loan: lend with caution', () => {
  assert.equal(ruleAdvice(facts({ loans: [loan(1, { status: 'active' })], installments: installments(10, { late: [3, 6, 8] }) })).verdict, 'caution');
  assert.equal(ruleAdvice(facts({ loans: [loan(1, { status: 'active' })], installments: installments(10, { overdue: [10] }) })).verdict, 'caution');
  assert.equal(ruleAdvice(facts({ loans: [loan(1, { restructurings: 1 })], installments: installments(10) })).verdict, 'caution');
});

test('mostly late or 3 overdue: do not lend for now', () => {
  const late = ruleAdvice(facts({ loans: [loan(1, { status: 'overdue', balance: 8000 })], installments: installments(9, { late: [1, 2, 3, 4, 5, 6, 7] }) }));
  assert.equal(late.verdict, 'do_not_lend');
  assert.match(late.suggestion, /^Do not lend to this member for now: only 2 of 9 installments were paid on time/);
  assert.equal(ruleAdvice(facts({ loans: [loan(1, { status: 'overdue' })], installments: installments(10, { overdue: [8, 9, 10] }) })).verdict, 'do_not_lend');
});

test('nothing due yet, or no loans: not enough history, and the AI is not asked', async () => {
  assert.equal(ruleAdvice(facts({ loans: [loan(1, { status: 'active' })], installments: [] })).verdict, 'no_history');
  const none = await adviseOnCredit(facts({ loans: [], installments: [] }));
  assert.equal(none.verdict, 'no_history');
  assert.equal(none.source, 'rules');
  assert.equal(none.notice, '');
  assert.match(none.suggestion, /has not borrowed yet/);
});

test('without an AI key the rule-based suggestion comes back with a notice', async () => {
  const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, OCR_AI_API_KEY: process.env.OCR_AI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  for (const key of Object.keys(saved)) delete process.env[key];
  try {
    const advice = await adviseOnCredit(facts({ loans: [loan(1)], installments: installments(6) }));
    assert.equal(advice.source, 'rules');
    assert.equal(advice.verdict, 'lend');
    assert.match(advice.notice, /AI is not set up/);
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
});
