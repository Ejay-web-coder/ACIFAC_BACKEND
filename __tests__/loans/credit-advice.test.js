import { jest, describe, test, expect, afterEach } from '@jest/globals';

// The AI service is mocked: it answers in one test and fails in another.
const ai = {
  AiUnavailableError: class AiUnavailableError extends Error {},
  askAi: jest.fn(),
  askAiText: jest.fn(),
  resetAiModelStateForTesting: jest.fn(),
  aiFailureReason: jest.fn(() => 'the AI service timed out'),
};
jest.unstable_mockModule('../../src/services/aiClient.js', () => ai);
const { adviseOnCredit, creditFacts, ruleAdvice } = await import('../../src/services/creditAdvice.js');

const paidLoan = { id: 1, amount: 30000, balance: 0, status: 'paid', dateApproved: '2025-11-03', restructurings: 0 };
const due = (onTime, overdue = false, daysLate = onTime ? 0 : 12) => ({ loanId: 1, dueDate: '2026-05-04', onTime, overdue, daysLate });
const factsOf = (installments, loans = [paidLoan]) => creditFacts({ loans, installments, today: '2026-11-11' });
afterEach(() => { delete process.env.GEMINI_API_KEY; jest.clearAllMocks(); });

describe('Credit advice for lending again (creditFacts, ruleAdvice, adviseOnCredit)', () => {
  test('counts on-time, late and overdue installments', () => {
    const facts = factsOf([due(true), due(true), due(false), due(false, true, 30)]);
    expect(facts.installments).toMatchObject({ due: 4, onTime: 2, late: 2, overdueNow: 1, onTimeRate: 50, averageDaysLate: 21, mostDaysLate: 30 });
    expect(facts.loans).toMatchObject({ total: 1, fullyPaid: 1, totalBorrowed: 30000 });
  });

  test('a member who always paid on time: can lend', () => {
    expect(ruleAdvice(factsOf([due(true), due(true), due(true)])).verdict).toBe('lend');
  });

  test('some late payments or one overdue: lend with caution', () => {
    expect(ruleAdvice(factsOf([due(true), due(true), due(true), due(false)])).verdict).toBe('caution');
    expect(ruleAdvice(factsOf([due(true), due(true), due(true), due(true), due(false, true)])).verdict).toBe('caution');
  });

  test('mostly late, or 3 overdue: do not lend for now', () => {
    const advice = ruleAdvice(factsOf([due(true), due(false), due(false)]));
    expect(advice.verdict).toBe('do_not_lend');
    expect(advice.suggestion).toBe('Do not lend to this member for now: only 1 of 3 installments were paid on time. Ask them to settle what is due first.');
  });

  test('no installment due yet: not enough history, and the AI is not asked', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const advice = await adviseOnCredit(factsOf([], []));
    expect(advice).toMatchObject({ source: 'rules', verdict: 'no_history' });
    expect(ai.askAiText).not.toHaveBeenCalled();
  });

  test('when the AI answers, its suggestion is used', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    ai.askAiText.mockResolvedValueOnce({ verdict: 'caution', suggestion: 'Lend a smaller amount: 1 of 4 installments was late.', reasons: ['3 of 4 on time'] });
    await expect(adviseOnCredit(factsOf([due(true), due(true), due(true), due(false)]))).resolves.toMatchObject({ source: 'ai', verdict: 'caution', reasons: ['3 of 4 on time'] });
  });

  test('when the AI fails or gives nonsense, the rule-based suggestion is shown with a notice', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    ai.askAiText.mockRejectedValueOnce(new Error('timeout'));
    await expect(adviseOnCredit(factsOf([due(true)]))).resolves.toMatchObject({ source: 'rules', verdict: 'lend', notice: 'AI could not answer (the AI service timed out), so this is the rule-based suggestion.' });
    ai.askAiText.mockResolvedValueOnce({ verdict: 'maybe', suggestion: '' });
    await expect(adviseOnCredit(factsOf([due(true)]))).resolves.toMatchObject({ source: 'rules', notice: 'The AI gave no usable suggestion, so this is the rule-based one.' });
  });

  test('without an AI key the rule-based suggestion comes back with a notice', async () => {
    await expect(adviseOnCredit(factsOf([due(true)]))).resolves.toMatchObject({ source: 'rules', notice: 'AI is not set up on the server, so this is the rule-based suggestion.' });
  });
});
