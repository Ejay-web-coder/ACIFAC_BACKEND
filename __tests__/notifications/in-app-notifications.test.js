import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer } from '../helpers/http.js';
import { createNotifications, notifyAdmins, notifyMember } from '../../src/services/notificationService.js';

const client = { query: jest.fn() };
const inserted = () => client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO notifications'));
beforeEach(() => { client.query.mockReset(); answer(client.query, [['INSERT INTO notifications', (params) => ({ rows: [], rowCount: params[0].length })]]); });

describe('In-app notifications (createNotifications, notifyMember, notifyAdmins)', () => {
  test('one notification per person, each user listed once', async () => {
    await expect(createNotifications(client, [7, '7', 8], { type: 'payment_recorded', title: 'Payment recorded', entityId: 90, dedupeKey: 'payment-90' })).resolves.toBe(2);
    expect(inserted()[1]).toEqual([[7, 8], 'payment_recorded', 'Payment recorded', '', 'info', null, null, '90', 'payment-90']);
  });

  test('a member is notified on their login account', async () => {
    answer(client.query, [
      ['SELECT id FROM users WHERE member_id = $1', { rows: [{ id: 7 }] }],
      ['INSERT INTO notifications', (params) => ({ rows: [], rowCount: params[0].length })],
    ]);
    await expect(notifyMember(client, 3, { type: 'rental_approved', title: 'Rental request approved' })).resolves.toBe(1);
  });

  test('invalid user IDs, or a member without an account, notify nobody', async () => {
    await expect(createNotifications(client, [0, -1, 'abc', null], { type: 'x', title: 'x' })).resolves.toBe(0);
    await expect(notifyMember(client, null, { type: 'x', title: 'x' })).resolves.toBe(0);
    expect(inserted()).toBeUndefined();
  });

  test('admins are notified, except the one who did the action', async () => {
    answer(client.query, [
      ["SELECT id FROM users WHERE role = 'ADMIN'", (params) => ({ rows: [{ id: 1 }, { id: 2 }].filter((row) => row.id !== params[0]) })],
      ['INSERT INTO notifications', (params) => ({ rows: [], rowCount: params[0].length })],
    ]);
    await expect(notifyAdmins(client, { type: 'rental_requested', title: 'New rental request' }, { exceptUserId: 1 })).resolves.toBe(1);
    expect(inserted()[1][0]).toEqual([2]);
  });

  test('edge case: a very long title is cut to 200 characters', async () => {
    await createNotifications(client, [7], { type: 'announcement', title: 'A'.repeat(250) });
    expect(inserted()[1][2]).toHaveLength(200);
  });
});
