import { describe, test, expect } from '@jest/globals';
import { loanDecisionEmail, passwordResetCodeEmail, paymentEmail, rentalDecisionEmail, welcomeMemberEmail } from '../../src/services/emailTemplates.js';

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

  test('an approved loan email lists what was taken from the proceeds and the cash received', () => {
    const base = { requestId: 41, amount: '50000.00', interestRate: '15', term: 6, status: 'approved', totalRepayment: '57500.00', repayment: 'single', dueDate: '2027-05-24' };
    const email = loanDecisionEmail({ ...base, deductions: { savings: '500.00', capitalBuildUp: '1000.00', capitalBuildUpToSavings: '300.00', pcicInsurance: '50.00', cashReleased: '48450.00', paidAtRelease: '0.00' } });
    expect(email.text).toContain('Taken from the loan proceeds:\nSavings: PHP 500.00\nCapital Build-Up (2%): PHP 1,000.00 (PHP 300.00 of it to savings, over the 10% share capital limit)\nPCIC life insurance: PHP 50.00\nCash you receive: PHP 48,450.00');
    expect(email.text).not.toContain('To pay at the office');
    const inKind = loanDecisionEmail({ ...base, amount: '20000.00', deductions: { savings: '500.00', capitalBuildUp: '400.00', capitalBuildUpToSavings: '0.00', pcicInsurance: '50.00', cashReleased: '0.00', paidAtRelease: '950.00' } });
    expect(inKind.text).toContain('To pay at the office when the loan is released: PHP 950.00');
    expect(loanDecisionEmail(base).text).not.toContain('Taken from the loan proceeds');
  });

  test('a declined rental email gives the reason the office wrote', () => {
    const email = rentalDecisionEmail({ machineryName: 'Water Pump', startDate: '2026-12-03', endDate: '2026-12-05', status: 'declined', rentalFee: '2400.00', reason: 'The pump is <under repair> that week.' });
    expect(email.subject).toBe('ACIFAC machinery rental declined');
    expect(email.text).toContain('Your rental request for Water Pump (December 3, 2026 to December 5, 2026) was declined.');
    expect(email.text).toContain('Reason: The pump is <under repair> that week.');
    expect(email.text).not.toContain('Rental fee');
    expect(email.html).toContain('The pump is &lt;under repair&gt; that week.');
    const approved = rentalDecisionEmail({ machineryName: 'Water Pump', startDate: '2026-12-03', endDate: '2026-12-05', status: 'approved', rentalFee: '2400.00' });
    expect(approved.text).toBe('Your rental request for Water Pump (December 3, 2026 to December 5, 2026) was approved. Rental fee: PHP 2,400.00.');
  });

  test('edge case: names are escaped in the HTML, so a name cannot inject markup', () => {
    const email = welcomeMemberEmail({ memberName: '<script>alert(1)</script>', memberNumber: 'ACIFAC-2026-004', membershipDate: '2026-01-15' });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });
});
