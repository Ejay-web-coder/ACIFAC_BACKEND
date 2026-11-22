import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN } from '../helpers/members.js';

// Email is "set up" here, but sendEmail is a mock: nothing leaves the machine.
const db = mockDatabase();
const email = mockEmailService();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', () => email);
const { createAnnouncement } = await import('../../src/controllers/communicationController.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const post = (body) => mockRequest({ method: 'POST', body, user: { ...ADMIN, full_name: 'Liza Ramos' } });
const memberQueries = () => db.module.query.mock.calls.filter(([sql]) => sql.includes('FROM members m'));

beforeEach(() => {
  jest.clearAllMocks();
  email.isEmailConfigured.mockImplementation(() => true);
  email.sendEmail.mockImplementation(async () => ({ sent: true }));
  answer(db.client.query, [
    ['INSERT INTO announcements', (params) => ({ rows: [{ id: 12, title: params[0], message: params[1], audience: params[2] }] })],
    ["SELECT id FROM users WHERE account_status = 'ACTIVE'", { rows: [{ id: 7 }] }],
  ]);
  answer(db.module.query, [['FROM members m', { rows: [{ email: 'juan@gmail.com' }, { email: 'rosa@yahoo.com' }, { email: 'member001@example.com' }] }]]);
});

describe('Announcements by email (communicationController.createAnnouncement)', () => {
  test('an announcement for all is emailed to the members, and the office is told how many', async () => {
    const res = mockResponse();
    await createAnnouncement(post({ title: 'General Assembly', message: 'Saturday, 8 AM at the ACIFAC hall.\n\nBring your ID.' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ emailedMembers: 2, message: 'Announcement posted. It is being emailed to 2 members.' });
    await settle();
    const [mail] = email.sendEmail.mock.calls[0];
    expect(mail.bcc).toEqual(['juan@gmail.com', 'rosa@yahoo.com']);
    expect(mail.subject).toBe('ACIFAC announcement: General Assembly');
    expect(mail.text).toContain('Saturday, 8 AM at the ACIFAC hall.\n\nBring your ID.');
    expect(mail.text).toMatch(/Posted on .+ by Liza Ramos\./);
    expect(mail.text).toContain('turn off Email Notifications');
    expect(mail.html).toContain('<p>Bring your ID.</p>');
  });

  test('a members-only announcement is emailed too', async () => {
    const res = mockResponse();
    await createAnnouncement(post({ title: 'Loan release', message: 'Friday.', audience: 'Members Only' }), res);
    expect(res.body.emailedMembers).toBe(2);
    expect(memberQueries()[0][1]).toEqual([null]);
  });

  test('announcements for administrators or vendors only are not emailed to members', async () => {
    for (const audience of ['Admins Only', 'Vendors Only']) {
      const res = mockResponse();
      await createAnnouncement(post({ title: 'Inventory', message: 'Count on Monday.', audience }), res);
      expect(res.body).toMatchObject({ emailedMembers: 0, message: 'Announcement posted.' });
    }
    await settle();
    expect(memberQueries()).toHaveLength(0);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  test('the HTML email shows the text, never markup typed into it', async () => {
    await createAnnouncement(post({ title: 'Meeting <b>now</b>', message: '<script>alert(1)</script>' }), mockResponse());
    await settle();
    const [mail] = email.sendEmail.mock.calls[0];
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('Meeting &lt;b&gt;now&lt;/b&gt;');
  });

  test('edge case: if the members cannot be looked up, the announcement is still posted', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    answer(db.module.query, [['FROM members m', new Error('connection reset')]]);
    const res = mockResponse();
    await createAnnouncement(post({ title: 'General Assembly', message: 'Saturday.' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, emailedMembers: 0, message: 'Announcement posted.' });
  });
});
