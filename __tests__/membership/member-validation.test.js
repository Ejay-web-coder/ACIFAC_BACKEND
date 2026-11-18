import { describe, test, expect } from '@jest/globals';
import { validateMemberInput } from '../../src/controllers/memberController.js';
import { todayDateOnly } from '../../src/utils/dates.js';

const valid = { first_name: 'Juan', last_name: 'Dela Cruz', phone: '0917 123 4567', address: 'Brgy. Bibiclat, Aliaga, Nueva Ecija', membership_date: '2026-01-15' };
const tomorrow = () => { const date = new Date(`${todayDateOnly()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };

describe('Member form validation (validateMemberInput)', () => {
  test('accepts a complete member form and defaults the status to active', () => {
    const { errors, values } = validateMemberInput({ ...valid, email: ' Juan@Example.COM ' });
    expect(errors).toEqual([]);
    expect(values).toMatchObject({ firstName: 'Juan', lastName: 'Dela Cruz', email: 'juan@example.com', status: 'active' });
  });

  test('rejects an invalid email and phone number', () => {
    const { errors } = validateMemberInput({ ...valid, email: 'juan@', phone: 'call me' });
    expect(errors).toEqual(['Email format is invalid.', 'Phone number format is invalid.']);
  });

  test('lists every required field that is blank', () => {
    expect(validateMemberInput({}).errors).toEqual([
      'First name is required.',
      'Last name is required.',
      'A valid membership date is required.',
      'Phone number is required.',
      'Address is required.',
    ]);
  });

  test('a blank email is allowed and saved as none', () => {
    const { errors, values } = validateMemberInput({ ...valid, email: '   ' });
    expect(errors).toEqual([]);
    expect(values.email).toBeNull();
  });

  test('membership and birth dates cannot be in the future or impossible', () => {
    expect(validateMemberInput({ ...valid, membership_date: tomorrow() }).errors).toEqual(['Membership date cannot be in the future.']);
    expect(validateMemberInput({ ...valid, date_of_birth: tomorrow() }).errors).toEqual(['Date of birth cannot be in the future.']);
    expect(validateMemberInput({ ...valid, membership_date: '2026-02-30' }).errors).toEqual(['A valid membership date is required.']);
  });

  test('farm areas and income must be non-negative numbers', () => {
    expect(validateMemberInput({ ...valid, farm_area_ha: '-1', yearly_income: 'abc' }).errors)
      .toEqual(['farm area ha must be a non-negative number.', 'yearly income must be a non-negative number.']);
    expect(validateMemberInput({ ...valid, farm_area_ha: '2.5', palay_area_ha: 0 }).errors).toEqual([]);
  });

  test('edge case: an archived status or an impossible spouse age is refused', () => {
    expect(validateMemberInput({ ...valid, status: 'archived' }).errors).toEqual(['Status must be active, inactive, or suspended.']);
    expect(validateMemberInput({ ...valid, spouse_age: 131 }).errors).toEqual(['Spouse age must be a whole number between 0 and 130.']);
  });
});
