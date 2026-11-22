import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockEmailService, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN } from '../helpers/members.js';

// Email is "set up" here, but sendEmail is a mock: nothing leaves the machine.
const db = mockDatabase();
const email = mockEmailService();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
jest.unstable_mockModule('../../src/services/emailService.js', () => email);
const { activityNotice, cancelActivity, createActivity } = await import('../../src/controllers/attendanceController.js');
const { activityEmail } = await import('../../src/services/emailTemplates.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

const day = (offset) => { const date = new Date(`${todayDateOnly()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const activity = (changes = {}) => ({
  id: 21, title: 'General Assembly', category: 'meeting', activity_date: day(7), start_time: '08:00:00', end_time: '12:00:00', venue: 'ACIFAC Hall',
  description: 'Election of officers.', organizer: 'Board of Directors', status: 'scheduled', attendee_scope: 'all', cancellation_reason: null, ...changes,
});
// What loadActivity reads back for the response.
const listed = { id: 21, title: 'General Assembly', category: 'meeting', status: 'scheduled', present: 0, late: 0, absent: 0, excused: 0, recorded: 0, finalizedAt: null };
const memberQuery = () => db.module.query.mock.calls.find(([sql]) => sql.includes('FROM members m'));
const sentMail = () => email.sendEmail.mock.calls.map(([mail]) => mail);

beforeEach(() => {
  jest.clearAllMocks();
  email.isEmailConfigured.mockImplementation(() => true);
  email.sendEmail.mockImplementation(async () => ({ sent: true }));
  answer(db.module.query, [
    ['FROM activities a', { rows: [listed] }],
    ['FROM activity_invitees WHERE activity_id', { rows: [{ member_id: 3 }, { member_id: 5 }] }],
    ['FROM members m', { rows: [{ email: 'juan@gmail.com' }, { email: 'member001@example.com' }] }],
  ]);
});

describe('What members are told about an activity (activityNotice, activityEmail)', () => {
  test('a new meeting says when and where, who must attend and what to bring', () => {
    const notice = activityNotice(activity(), 'created');
    expect(notice).toMatchObject({ change: 'created', noun: 'meeting', title: 'New meeting: General Assembly', selected: false });
    expect(notice.message).toMatch(/^.+, 8:00 AM to 12:00 PM at ACIFAC Hall\. All members must attend\. Bring PHP .+ for share capital/);
    expect(activityNotice(activity({ category: 'education_training', attendee_scope: 'selected' }), 'created').note).toBe('You are one of the members who must attend.');
  });

  test('activities on a past date, or no longer scheduled, are not announced', () => {
    expect(activityNotice(activity({ activity_date: day(-1) }), 'created')).toBeNull();
    expect(activityNotice(activity({ activity_date: day(-1) }), 'cancelled')).toBeNull();
    expect(activityNotice(activity({ status: 'cancelled' }), 'changed')).toBeNull();
    expect(activityNotice(activity({ status: 'cancelled' }), 'cancelled')).not.toBeNull();
  });

  test('the email for a new activity has its details and a link to Attendance', () => {
    const notice = activityNotice(activity(), 'created');
    const mail = activityEmail({ ...notice, title: 'General Assembly', venue: 'ACIFAC Hall', organizer: 'Board of Directors', description: 'Election of officers.' });
    expect(mail.subject).toBe('ACIFAC meeting: General Assembly');
    expect(mail.text).toContain('ACIFAC has a new meeting: General Assembly.');
    expect(mail.text).toMatch(/When: .+, 8:00 AM to 12:00 PM\nWhere: ACIFAC Hall\nOrganized by: Board of Directors/);
    expect(mail.text).toContain('Election of officers.');
    expect(mail.html).toMatch(/<a href="[^"]+\/member\/attendance">/);
  });

  test('the email for a cancellation gives the reason and no longer says when to come', () => {
    const notice = activityNotice(activity({ status: 'cancelled', cancellation_reason: 'Typhoon signal no. 2' }), 'cancelled');
    const mail = activityEmail({ ...notice, title: 'General Assembly', venue: 'ACIFAC Hall', reason: 'Typhoon signal no. 2' });
    expect(mail.subject).toBe('ACIFAC meeting cancelled: General Assembly');
    expect(mail.text).toMatch(/The meeting "General Assembly" on .+ was cancelled\.\nReason: Typhoon signal no\. 2/);
    expect(mail.text).not.toContain('When:');
  });
});

describe('Activity emails (attendanceController: createActivity, cancelActivity)', () => {
  test('a new activity for all members is emailed to them after it is saved', async () => {
    answer(db.client.query, [['INSERT INTO activities', { rows: [activity()] }]]);
    const res = mockResponse();
    await createActivity(mockRequest({ method: 'POST', user: ADMIN, body: { title: 'General Assembly', category: 'meeting', activityDate: day(7), startTime: '08:00', endTime: '12:00', venue: 'ACIFAC Hall' } }), res);
    expect(res.statusCode).toBe(201);
    await settle();
    expect(memberQuery()[1]).toEqual([null]);
    expect(sentMail()).toHaveLength(1);
    expect(sentMail()[0]).toMatchObject({ to: 'undisclosed-recipients:;', bcc: ['juan@gmail.com'], subject: 'ACIFAC meeting: General Assembly' });
  });

  test('an activity for selected members is emailed only to them', async () => {
    answer(db.client.query, [
      ['INSERT INTO activities', { rows: [activity({ attendee_scope: 'selected', category: 'education_training', title: 'Rice Training' })] }],
      ['SELECT COUNT(*)::int AS count FROM members', { rows: [{ count: 2 }] }],
    ]);
    await createActivity(mockRequest({ method: 'POST', user: ADMIN, body: { title: 'Rice Training', category: 'education_training', activityDate: day(7), startTime: '08:00', endTime: '12:00', venue: 'ACIFAC Hall', attendeeScope: 'selected', memberIds: [3, 5] } }), mockResponse());
    await settle();
    expect(memberQuery()[1]).toEqual([[3, 5]]);
    expect(sentMail()[0].subject).toBe('ACIFAC activity: Rice Training');
  });

  test('cancelling an activity emails the members the reason', async () => {
    answer(db.client.query, [
      ['FROM activities WHERE id = $1 FOR UPDATE', { rows: [activity()] }],
      ["UPDATE activities SET status = 'cancelled'", { rows: [activity({ status: 'cancelled', cancellation_reason: 'Typhoon signal no. 2' })] }],
    ]);
    await cancelActivity(mockRequest({ method: 'PATCH', user: ADMIN, params: { id: '21' }, body: { reason: 'Typhoon signal no. 2' } }), mockResponse());
    await settle();
    expect(sentMail()[0].subject).toBe('ACIFAC meeting cancelled: General Assembly');
    expect(sentMail()[0].text).toContain('Reason: Typhoon signal no. 2');
  });

  test('edge case: an activity recorded after it took place is not emailed', async () => {
    answer(db.client.query, [['INSERT INTO activities', { rows: [activity({ activity_date: day(-3), status: 'completed' })] }]]);
    await createActivity(mockRequest({ method: 'POST', user: ADMIN, body: { title: 'General Assembly', category: 'meeting', activityDate: day(-3), startTime: '08:00', endTime: '12:00', venue: 'ACIFAC Hall', status: 'completed' } }), mockResponse());
    await settle();
    expect(memberQuery()).toBeUndefined();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
});
