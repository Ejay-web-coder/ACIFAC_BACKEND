import { jest, describe, test, expect } from '@jest/globals';
import { prepareApplication } from '../../src/controllers/loanController.js';

// Stands in for PostgreSQL's loan arithmetic (ROUND to the centavo), as calculateLoanFinancials asks it.
const loanMathDb = {
  query: jest.fn(async (sql, [farmArea, perHectare, amount, rate, count]) => {
    const cents = (value) => Math.round(Number(value) * 100);
    const text = (value) => (value / 100).toFixed(2);
    const interest = Math.round((cents(amount) * Number(rate)) / 100);
    const total = cents(amount) + interest;
    return { rows: [{ maximum_eligible_amount: text(Math.round(Number(farmArea) * Number(perHectare) * 100)), calculated_interest: text(interest), total_repayment: text(total), monthly_payment: text(Math.round(total / count)) }] };
  }),
};
const member = { farm_area_ha: '2', email: 'juan@example.com', phone: '09171234567', address: 'Brgy. Bibiclat, Aliaga', gender: 'Male', livelihood: 'Rice farmer' };
const apply = (body) => prepareApplication(loanMathDb, { loanType: 'agricultural', loanMode: 'cash', purpose: 'Palay production', amount: '30000', farmArea: '2', ...body }, member);

describe('Loan application (loanController.prepareApplication)', () => {
  test('accepts a cash loan within the limit and computes 15% interest for 6 months', async () => {
    const application = await apply();
    expect(application).toMatchObject({ loanType: 'agricultural', loanMode: 'cash', term: 6, requestedAmount: '30000', borrowerEmail: 'juan@example.com' });
    expect(application.financials).toEqual({ maximum_eligible_amount: '100000.00', calculated_interest: '4500.00', total_repayment: '34500.00', monthly_payment: '34500.00' });
  });

  test('refuses more than PHP 50,000 per hectare of the member\'s farm', async () => {
    await expect(apply({ amount: '100000.01' })).rejects.toMatchObject({ status: 400, message: 'Requested loan amount exceeds the maximum eligible amount of PHP 100,000.00 for 2 hectares.' });
  });

  test('a paper form adds the cash and the farm inputs together', async () => {
    const application = await apply({ purpose: '', cropsPlanted: 'Palay', loanMode: 'combination', amount: undefined, cashAmount: '10000', inKindItems: [{ item: 'Urea', quantity: '4', unit: 'bag', unitPrice: '1650' }] });
    expect(application.requestedAmount).toBe('16600.00');
    expect(application.purpose).toBe('Agricultural loan for Palay (combination).');
  });

  test('rejects a missing purpose, an invalid amount and a zero farm area', async () => {
    await expect(apply({ purpose: '' })).rejects.toMatchObject({ message: 'Loan type and loan purpose are required.' });
    await expect(apply({ amount: 'thirty thousand' })).rejects.toMatchObject({ message: 'Requested loan amount must be a valid positive amount with up to two decimal places.' });
    await expect(apply({ farmArea: '0' })).rejects.toMatchObject({ message: 'Farm area must be greater than zero.' });
  });

  test('only agricultural loans in cash, in kind or both are given', async () => {
    await expect(apply({ loanType: 'salary' })).rejects.toMatchObject({ message: 'ACIFAC gives agricultural loans only.' });
    await expect(apply({ loanMode: 'gold' })).rejects.toMatchObject({ message: 'Loan mode must be cash, in-kind, or combination.' });
  });

  test('an in-kind loan needs at least one complete farm input', async () => {
    await expect(apply({ loanMode: 'in-kind', inKindItems: [] })).rejects.toMatchObject({ message: 'Add at least one farm input for an in-kind or combination loan.' });
    await expect(apply({ loanMode: 'in-kind', inKindItems: [{ item: 'Urea', quantity: '4', unitPrice: '1650' }] })).rejects.toMatchObject({ message: 'Each in-kind item needs a unit.' });
  });

  test('an incomplete co-maker or collateral is refused', async () => {
    await expect(apply({ coMakerName: 'Pedro Penduko' })).rejects.toMatchObject({ message: 'Complete valid co-maker information is required once a co-maker is provided.' });
    await expect(apply({ collateralType: 'Land title' })).rejects.toMatchObject({ message: 'Provide both collateral type and collateral details.' });
  });

  test('edge case: a borrower with no contact number on record cannot apply', async () => {
    await expect(prepareApplication(loanMathDb, { loanType: 'agricultural', purpose: 'Palay', amount: '1000', farmArea: '1' }, { ...member, phone: '' }))
      .rejects.toMatchObject({ status: 400, message: 'A valid borrower contact number is required.' });
  });
});
