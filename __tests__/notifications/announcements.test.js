import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN } from '../helpers/members.js';

const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { audiencesFor, createAnnouncement } = await import('../../src/controllers/communicationController.js');

beforeEach(() => {
  jest.clearAllMocks();
  answer(db.client.query, [
    ['INSERT INTO announcements', (params) => ({ rows: [{ id: 12, title: params[0], message: params[1], audience: params[2] }] })],
    ["SELECT id FROM users WHERE account_status = 'ACTIVE'", { rows: [{ id: 7 }, { id: 8 }] }],
  ]);
});
const post = (body) => mockRequest({ method: 'POST', body, user: ADMIN });
const recipientsQuery = () => db.client.query.mock.calls.find(([sql]) => sql.includes("SELECT id FROM users WHERE account_status = 'ACTIVE'"));

describe('Announcements (communicationController.createAnnouncement)', () => {
  test('posts an announcement and notifies everyone else', async () => {
    const res = mockResponse();
    await createAnnouncement(post({ title: 'General Assembly', message: 'Saturday, 8 AM at the ACIFAC hall.' }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Announcement posted.', data: { id: 12, audience: 'All' } });
    expect(recipientsQuery()[1]).toEqual([1, null]);
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
    expect(params.slice(0, 3)).toEqual([[7, 8], 'announcement', 'Announcement: General Assembly']);
  });

  test('a members-only announcement goes only to member accounts', async () => {
    await createAnnouncement(post({ title: 'Loan release', message: 'Loans approved this week are released on Friday.', audience: 'Members Only' }), mockResponse());
    expect(recipientsQuery()[1]).toEqual([1, 'MEMBER']);
  });

  test('rejects an announcement without a title or message', async () => {
    await expect(createAnnouncement(post({ title: '', message: 'x' }), mockResponse())).rejects.toMatchObject({ status: 400, message: 'Please complete the announcement title and message.' });
    await expect(createAnnouncement(post({ title: 'x' }), mockResponse())).rejects.toMatchObject({ status: 400 });
  });

  test('rejects an audience that does not exist', async () => {
    await expect(createAnnouncement(post({ title: 'x', message: 'y', audience: 'Everyone in town' }), mockResponse()))
      .rejects.toMatchObject({ status: 400, message: 'Choose who the announcement is for: All, Members Only, Admins Only or Vendors Only.' });
  });

  test('members see only announcements for all and for members', () => {
    expect(audiencesFor('MEMBER')).toEqual(['All', 'Members Only']);
    expect(audiencesFor('ADMIN')).toEqual(['All', 'Members Only', 'Admins Only', 'Vendors Only']);
  });

  test('edge case: a long message is shortened in the notification, with "..."', async () => {
    await createAnnouncement(post({ title: 'Minutes', message: 'M'.repeat(300) }), mockResponse());
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
    expect(params[3]).toHaveLength(240);
    expect(params[3].endsWith('...')).toBe(true);
  });
});
