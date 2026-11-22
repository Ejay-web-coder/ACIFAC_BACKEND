import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { ADMIN } from '../helpers/members.js';

// The savings and share capital records are mocked: recordLoanDeductions is
// checked for what it asks them to record, and what it keeps on the loan.
const records = {
  insertSavingsDeposit: jest.fn(async (client, req, input) => ({ record: { id: input.reference.endsWith('-SAV') ? 801 : 802 } })),
  insertShareContribution: jest.fn(async () => ({ contribution: { id: 901 } })),
  shareCapitalRoomCents: jest.fn(async () => 100000000),
};
jest.unstable_mockModule('../../src/controllers/memberController.js', () => records);
const {
  eligibleFarmArea, firstLoanYear, firstYearLimitText, inKindCentsOf, loanDeductions, loanRelease, recordLoanDeductions,
} = await import('../../src/services/loanDeductions.js');
const { prepareApplication } = await import('../../src/controllers/loanController.js');

const req = { user: ADMIN, headers: {}, ip: '127.0.0.1', get: () => '' };
const loanRow = (changes = {}) => ({ id: 41, loan_number: 'L-2026-041', member_id: 3, amount: '50000.00', loan_mode: 'cash', in_kind_items: [], date_approved: '2026-11-22', ...changes });
const clientFor = (loan) => ({ query: jest.fn(async (sql) => (sql.includes('FROM loans WHERE id = $1') ? { rows: [loan] } : { rows: [], rowCount: 1 })) });
const updateParams = (client) => client.query.mock.calls.find(([sql]) => sql.includes('UPDATE loans SET savings_deducted'))[1];

beforeEach(() => jest.clearAllMocks());

describe('Deductions from the loan proceeds (loanDeductions, loanRelease)', () => {
  test('PHP 500 savings up to a PHP 50,000 loan, PHP 1,000 above, 2% Capital Build-Up and PHP 50 PCIC', () => {
    expect(loanDeductions(5000000)).toEqual({ savingsCents: 50000, capitalBuildUpCents: 100000, pcicCents: 5000, totalCents: 155000 });
    expect(loanDeductions(5100000)).toEqual({ savingsCents: 100000, capitalBuildUpCents: 102000, pcicCents: 5000, totalCents: 207000 });
    expect(loanDeductions(1234567).capitalBuildUpCents).toBe(24691);
  });

  test('edge case: just over PHP 50,000 (the policy names only PHP 51,000 and up) takes PHP 1,000', () => {
    expect(loanDeductions(5000001).savingsCents).toBe(100000);
    expect(loanDeductions(5000000).savingsCents).toBe(50000);
  });

  test('a cash loan: the borrower receives the loan less the deductions', () => {
    expect(loanRelease({ amountCents: 5000000 })).toMatchObject({ cashPartCents: 5000000, cashReleasedCents: 4845000, paidAtReleaseCents: 0 });
  });

  test('a combination loan: the deductions come out of its cash part', () => {
    expect(loanRelease({ amountCents: 10000000, inKindCents: 6000000 })).toMatchObject({ totalCents: 305000, cashPartCents: 4000000, cashReleasedCents: 3695000, paidAtReleaseCents: 0 });
  });

  test('an in-kind loan has no cash: the borrower pays the deductions at release', () => {
    expect(loanRelease({ amountCents: 2000000, inKindCents: 2000000 })).toMatchObject({ totalCents: 95000, cashReleasedCents: 0, paidAtReleaseCents: 95000 });
  });

  test('a restructuring: what the old loan still owed comes off first, then the deductions', () => {
    expect(loanRelease({ amountCents: 6000000, carriedCents: 3000000 })).toMatchObject({ totalCents: 225000, cashReleasedCents: 2775000, paidAtReleaseCents: 0 });
    expect(loanRelease({ amountCents: 6000000, carriedCents: 5950000 })).toMatchObject({ cashReleasedCents: 0, paidAtReleaseCents: 175000 });
  });

  test('the farm inputs of a loan, by its mode', () => {
    const inKindItems = [{ quantity: '4', unitPrice: '1650' }, { quantity: '2.5', unitPrice: '1000.10' }];
    expect(inKindCentsOf({ loanMode: 'cash', amountCents: 900000, inKindItems })).toBe(0);
    expect(inKindCentsOf({ loanMode: 'combination', amountCents: 1910025, inKindItems })).toBe(910025);
    expect(inKindCentsOf({ loanMode: 'in-kind', amountCents: 910025, inKindItems })).toBe(910025);
  });
});

describe('The 2-hectare limit of a member\'s first year of loans (firstLoanYear, eligibleFarmArea)', () => {
  const db = (row) => ({ query: jest.fn(async () => ({ rows: [row] })) });

  test('a member with no loan yet is in their first year', async () => {
    await expect(firstLoanYear(db({ first_loan_on: null, ends_on: null }), 3, '2026-11-22')).resolves.toEqual({ firstLoanOn: null, endsOn: null, inFirstYear: true });
  });

  test('the first year lasts 12 months from the first loan', async () => {
    const row = { first_loan_on: '2026-01-15', ends_on: '2027-01-15' };
    await expect(firstLoanYear(db(row), 3, '2027-01-14')).resolves.toMatchObject({ inFirstYear: true });
    await expect(firstLoanYear(db(row), 3, '2027-01-15')).resolves.toMatchObject({ inFirstYear: false });
  });

  test('in the first year a loan covers at most 2 hectares; after it, the whole farm', () => {
    expect(eligibleFarmArea('3.5', { inFirstYear: true })).toBe('2');
    expect(eligibleFarmArea('1.25', { inFirstYear: true })).toBe('1.25');
    expect(eligibleFarmArea('3.5', { inFirstYear: false })).toBe('3.5');
    expect(firstYearLimitText({ endsOn: '2027-01-15' })).toBe('In a member\'s first year of loans (until January 15, 2027), a loan may cover at most 2 hectares');
  });
});

describe('Recording the deductions at release (recordLoanDeductions)', () => {
  test('the savings is a deposit and the Capital Build-Up a share contribution, both linked to the loan', async () => {
    const client = clientFor(loanRow());
    const release = await recordLoanDeductions(client, req, 41);
    expect(records.insertSavingsDeposit).toHaveBeenCalledTimes(1);
    expect(records.insertSavingsDeposit.mock.calls[0][2]).toMatchObject({ memberId: 3, amountCents: 50000, date: '2026-11-22', paymentMethod: 'Loan deduction', reference: 'L-2026-041-SAV' });
    expect(records.insertShareContribution.mock.calls[0][3]).toMatchObject({ amountCents: 100000, contributionDate: '2026-11-22', paymentMethod: 'Loan deduction', referenceNumber: 'L-2026-041-CBU' });
    expect(updateParams(client)).toEqual([41, '500.00', '1000.00', '0.00', '50.00', '48450.00', '0.00', 801, 901, null]);
    expect(release).toMatchObject({ shareCents: 100000, overLimitCents: 0 });
  });

  test('Capital Build-Up over the 10% share capital limit goes to savings instead', async () => {
    records.shareCapitalRoomCents.mockResolvedValueOnce(30000);
    const client = clientFor(loanRow());
    const release = await recordLoanDeductions(client, req, 41);
    expect(records.insertShareContribution.mock.calls[0][3].amountCents).toBe(30000);
    const over = records.insertSavingsDeposit.mock.calls[1][2];
    expect(over).toMatchObject({ amountCents: 70000, reference: 'L-2026-041-CBU' });
    expect(over.notes).toMatch(/over the 10% share capital limit/);
    expect(updateParams(client).slice(1, 4)).toEqual(['500.00', '1000.00', '700.00']);
    expect(updateParams(client).slice(7)).toEqual([801, 901, 802]);
    expect(release.overLimitCents).toBe(70000);
  });

  test('edge case: a member at the limit puts all of it in savings and records no share contribution', async () => {
    records.shareCapitalRoomCents.mockResolvedValueOnce(0);
    const client = clientFor(loanRow());
    await recordLoanDeductions(client, req, 41);
    expect(records.insertShareContribution).not.toHaveBeenCalled();
    expect(records.insertSavingsDeposit.mock.calls.map(([, , input]) => input.amountCents)).toEqual([50000, 100000]);
    expect(updateParams(client)[8]).toBeNull();
  });

  test('an in-kind loan keeps what the borrower pays at release', async () => {
    const client = clientFor(loanRow({ amount: '20000.00', loan_mode: 'in-kind' }));
    await recordLoanDeductions(client, req, 41);
    expect(updateParams(client).slice(5, 7)).toEqual(['0.00', '950.00']);
  });

  test('a restructuring\'s payoff is taken before the deductions', async () => {
    const client = clientFor(loanRow({ amount: '60000.00' }));
    await recordLoanDeductions(client, req, 41, { carriedCents: 3000000 });
    expect(updateParams(client).slice(1, 7)).toEqual(['1000.00', '1200.00', '0.00', '50.00', '27750.00', '0.00']);
  });
});

describe('Applying in the first year of loans (loanController.prepareApplication)', () => {
  // The loan arithmetic as PostgreSQL does it, and the member's first loan.
  const dbWith = (firstLoan) => ({
    query: jest.fn(async (sql, params) => {
      if (sql.includes('MIN(date_approved)')) return { rows: [firstLoan] };
      const [farmArea, perHectare, amount, rate, count] = params;
      const cents = (value) => Math.round(Number(value) * 100);
      const interest = Math.round((cents(amount) * Number(rate)) / 100);
      const text = (value) => (value / 100).toFixed(2);
      return { rows: [{ maximum_eligible_amount: text(Math.round(Number(farmArea) * Number(perHectare) * 100)), calculated_interest: text(interest), total_repayment: text(cents(amount) + interest), monthly_payment: text(Math.round((cents(amount) + interest) / count)) }] };
    }),
  });
  const member = { id: 3, farm_area_ha: '3.5', email: 'juan@example.com', phone: '09171234567', address: 'Brgy. Bibiclat, Aliaga' };
  const apply = (db, amount) => prepareApplication(db, { loanType: 'agricultural', loanMode: 'cash', purpose: 'Palay production', amount, farmArea: '3.5' }, member);
  const firstTime = { first_loan_on: null, ends_on: null };

  test('a first-time borrower with 3.5 hectares may borrow for 2 of them', async () => {
    const application = await apply(dbWith(firstTime), '100000');
    expect(application.financials.maximum_eligible_amount).toBe('100000.00');
    expect(application.farmArea).toBe('3.5');
    await expect(apply(dbWith(firstTime), '100000.01')).rejects.toMatchObject({
      status: 400, message: 'In a member\'s first year of loans (counted from their first loan), a loan may cover at most 2 hectares, so the most that can be borrowed is PHP 100,000.00.',
    });
  });

  test('within 12 months of the first loan the limit still holds; after them the whole farm counts', async () => {
    await expect(apply(dbWith({ first_loan_on: '2026-06-01', ends_on: '2099-06-01' }), '150000')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/until June 1, 2099/) });
    const later = await apply(dbWith({ first_loan_on: '2020-06-01', ends_on: '2021-06-01' }), '150000');
    expect(later.financials.maximum_eligible_amount).toBe('175000.00');
  });
});
