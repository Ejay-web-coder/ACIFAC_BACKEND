import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', () => mockEmailService());
const { createAdminAccount } = await import('../../src/controllers/adminAccountController.js');

function databaseHas({ usernameTaken = false, emailVerified = true } = {}) {
  answer(db.client.query, [
    ['SELECT 1 FROM users WHERE LOWER(username) = $1', { rows: usernameTaken ? [{ '?column?': 1 }] : [] }],
    ['FROM contact_verifications', { rows: emailVerified ? [{ id: 5 }] : [] }],
    ['INSERT INTO users', (params) => ({ rows: [{ id: 30, username: params[0], email: params[1], phone: params[2], password_hash: params[3], role: 'ADMIN' }] })],
  ]);
}
const form = { fullName: 'Maria Santos', position: 'Secretary', username: 'maria.santos', email: 'maria@example.com', phone: '0917 123 4567', password: 'Admin123!', confirmPassword: 'Admin123!', emailVerificationId: 5 };
const create = (changes = {}) => mockRequest({ method: 'POST', body: { ...form, ...changes }, user: { id: 1, username: 'admin', role: 'ADMIN', full_name: 'Chair Person' } });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Create administrator account (adminAccountController.createAdminAccount)', () => {
  test('creates the administrator once the email is verified', async () => {
    const res = mockResponse();
    await createAdminAccount(create(), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toBe('Maria Santos can now sign in as Secretary with the username maria.santos, the email or the mobile number, and must choose a new password at first sign-in.');
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(params[2]).toBe('09171234567');
    expect(res.body.user).not.toHaveProperty('password_hash');
  }, 30000);

  test('rejects an invalid email or mobile number', async () => {
    await expect(createAdminAccount(create({ email: 'maria@' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Enter a valid email address.' });
    await expect(createAdminAccount(create({ phone: '12345' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Enter a valid mobile number, like 0917 123 4567.' });
  });

  test('rejects a weak or mismatched password', async () => {
    await expect(createAdminAccount(create({ password: 'admin123!', confirmPassword: 'admin123!' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Password must contain at least one uppercase letter.' });
    await expect(createAdminAccount(create({ confirmPassword: 'Admin123?' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'The passwords do not match.' });
  });

  test('rejects a blank form, a short name and a bad username', async () => {
    await expect(createAdminAccount(mockRequest({ method: 'POST', body: {} }), mockResponse())).rejects.toMatchObject({ status: 400, message: "Enter the new administrator's email." });
    await expect(createAdminAccount(create({ fullName: 'Al' }), mockResponse())).rejects.toMatchObject({ message: "Enter the new administrator's full name." });
    await expect(createAdminAccount(create({ username: 'M S' }), mockResponse())).rejects.toMatchObject({ message: 'Username: use 3 or more lowercase letters, numbers, dots, dashes or underscores.' });
  });

  test('refuses a username that is already taken', async () => {
    databaseHas({ usernameTaken: true });
    await expect(createAdminAccount(create(), mockResponse())).rejects.toMatchObject({ status: 409, message: 'This username is already taken.' });
  }, 30000);

  test('refuses to create the account before the email is verified', async () => {
    databaseHas({ emailVerified: false });
    await expect(createAdminAccount(create(), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Verify the email first: send the code and enter it.' });
  }, 30000);
});
