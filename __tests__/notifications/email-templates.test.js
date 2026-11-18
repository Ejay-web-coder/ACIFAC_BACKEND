import { describe, test, expect } from '@jest/globals';
import { loanDecisionEmail, passwordResetCodeEmail, paymentEmail, welcomeMemberEmail } from '../../src/services/emailTemplates.js';

describe('Email messages (emailTemplates)', () => {
  test('an approved loan email gives the amounts, the 2.5% a month interest and the due date', () => {
    const email = loanDecisionEmail({ requestId: 'LR-2026-014', amount: '30000', interestRate: '15', term: 6, status: 'approved', totalRepayment: '34500', repayment: 'single', dueDate: '2027-05-11' });
    expect(email.subject).toBe('ACIFAC loan application approved');
    expect(email.text).toContain('Amount: PHP 30,000.00\nInterest: 2.5% of principal a month for 6 months (15% in all)\nTotal repayment: PHP 34,500.00\nPayment: the whole PHP 34,500.00, due by May 11, 2027');
  });

  test('a declined loan email gives the reason, or tells the member to ask the office', () => {
    expect(loanDecisionEmail({ requestId: 'LR-2026-015', status: 'declined', reason: 'Farm area not verified.' }).text).toContain('Reason: Farm area not verified.');
    expect(loanDecisionEmail({ requestId: 'LR-2026-016', status: 'declined' }).text).toContain('Reason: Please contact ACIFAC for more information.');
  });

  test('the payment email shows the amount paid and the balance left', () => {
    expect(paymentEmail({ memberName: 'Juan Dela Cruz', amount: '5000', paymentDate: '2026-11-02', loanNumber: 'L-2026-005', remainingBalance: '29500', status: 'recorded' }).text)
      .toBe('Hello Juan Dela Cruz, your payment of PHP 5,000.00 for loan L-2026-005 was recorded on 2026-11-02. Remaining balance: PHP 29,500.00.');
  });

  test('the password reset email carries the code and its expiry, and no link', () => {
    const email = passwordResetCodeEmail({ code: '482913', expiresInMinutes: 10 });
    expect(email.subject).toBe('ACIFAC Password Reset');
    expect(email.text).toContain('Your verification code is:\n\n482913\n\nThis code expires in 10 minutes.');
    expect(email.html).not.toContain('href');
  });

  test('edge case: names are escaped in the HTML, so a name cannot inject markup', () => {
    const email = welcomeMemberEmail({ memberName: '<script>alert(1)</script>', memberNumber: 'ACIFAC-2026-004', membershipDate: '2026-01-15' });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});
