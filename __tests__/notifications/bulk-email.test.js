import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService } from '../helpers/http.js';

// Email is "set up" here, but sendEmail is a mock: nothing leaves the machine.
const db = mockDatabase();
const email = mockEmailService();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', () => email);
const { BULK_BATCH_SIZE, bulkEmailRecipients, emailInBulk, emailMembersInBulk, isDeliverableAddress } = await import('../../src/services/memberEmails.js');

const message = { subject: 'ACIFAC announcement: General Assembly', text: 'Saturday, 8 AM.', html: '<p>Saturday, 8 AM.</p>' };
const addresses = (count) => Array.from({ length: count }, (_, index) => `member${index + 1}@gmail.com`);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  email.isEmailConfigured.mockImplementation(() => true);
  email.sendEmail.mockImplementation(async () => ({ sent: true }));
});

describe('Email to many members (memberEmails: bulkEmailRecipients, emailInBulk)', () => {
  test('addresses on domains reserved for examples and tests are never mailed', () => {
    expect(['juan@gmail.com', 'rosa.reyes@acifac.ph', 'office@acifac.local'].map(isDeliverableAddress)).toEqual([true, true, true]);
    expect(['member001@example.com', 'a@mail.example.org', 'b@school.test', 'c@x.invalid', 'd@localhost', 'e@site.example'].map(isDeliverableAddress))
      .toEqual([false, false, false, false, false, false]);
  });

  test('the recipients are active members\' addresses, without the sample ones', async () => {
    answer(db.module.query, [['FROM members m', { rows: [{ email: 'juan@gmail.com' }, { email: 'member001@example.com' }, { email: 'rosa@yahoo.com' }] }]]);
    await expect(bulkEmailRecipients(null)).resolves.toEqual(['juan@gmail.com', 'rosa@yahoo.com']);
    const [sql, params] = db.module.query.mock.calls[0];
    expect(params).toEqual([null]);
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("notification_preferences ->> 'emailNotifications'");
    expect(sql).toContain('DISTINCT ON (lower(r.email))');
    await bulkEmailRecipients([3, 4]);
    expect(db.module.query.mock.calls[1][1]).toEqual([[3, 4]]);
  });

  test('one message per 50 addresses, all of them as BCC', async () => {
    await expect(emailInBulk(addresses(120), message)).resolves.toBe(120);
    const sent = email.sendEmail.mock.calls.map(([mail]) => mail);
    expect(sent.map((mail) => mail.bcc.length)).toEqual([BULK_BATCH_SIZE, BULK_BATCH_SIZE, 20]);
    expect(sent.every((mail) => mail.to === 'undisclosed-recipients:;' && mail.subject === message.subject)).toBe(true);
    expect(new Set(sent.flatMap((mail) => mail.bcc)).size).toBe(120);
  });

  test('a batch that fails does not stop the others', async () => {
    email.sendEmail.mockImplementationOnce(async () => ({ sent: true })).mockImplementationOnce(async () => { throw new Error('421 try again later'); });
    await expect(emailInBulk(addresses(120), message)).resolves.toBe(70);
    expect(email.sendEmail).toHaveBeenCalledTimes(3);
  });

  test('without email set up nothing is looked up or sent', async () => {
    email.isEmailConfigured.mockImplementation(() => false);
    await expect(bulkEmailRecipients(null)).resolves.toEqual([]);
    expect(db.module.query).not.toHaveBeenCalled();
    email.sendEmail.mockImplementation(async () => ({ sent: false, skipped: true }));
    await expect(emailInBulk(addresses(120), message)).resolves.toBe(0);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('edge case: no members, an empty list or a database error sends nothing and never throws', async () => {
    await expect(bulkEmailRecipients([])).resolves.toEqual([]);
    await expect(emailInBulk([], message)).resolves.toBe(0);
    answer(db.module.query, [['FROM members m', new Error('connection reset')]]);
    await expect(emailMembersInBulk(null, message)).resolves.toBe(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
});
