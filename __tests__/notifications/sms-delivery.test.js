import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase } from '../helpers/http.js';

// A configured SMS gateway with a fake address and key; fetch is mocked, so no
// text is ever sent. The gateway accepts in one test and fails in another.
process.env.TEXTBEE_API_KEY = 'test-key';
process.env.TEXTBEE_DEVICE_ID = 'device-1';
process.env.TEXTBEE_API_URL = 'http://textbee.test/api/v1';
const fetchMock = jest.fn();
globalThis.fetch = fetchMock;
const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const { isSmsConfigured, queueSmsForUsers, sendSmsSafely } = await import('../../src/services/smsService.js');

beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {}); });

describe('Text message delivery (sendSmsSafely, queueSmsForUsers)', () => {
  test('sends the signed text to the member\'s number when the gateway accepts', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    expect(isSmsConfigured()).toBe(true);
    await expect(sendSmsSafely('0917 123 4567', 'Your loan payment was recorded.')).resolves.toEqual({ sent: true });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('http://textbee.test/api/v1/gateway/devices/device-1/send-sms');
    expect(request.headers['x-api-key']).toBe('test-key');
    expect(JSON.parse(request.body)).toEqual({ recipients: ['+639171234567'], message: 'Your loan payment was recorded.\n- ACIFAC Administrator' });
  });

  test('reports a failure when the gateway refuses, without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'device offline' });
    const result = await sendSmsSafely('09171234567', 'Test');
    expect(result.sent).toBe(false);
    expect(result.error.message).toBe('textbee answered 503: device offline');
  });

  test('a network error is caught, never thrown', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    await expect(sendSmsSafely('09171234567', 'Test')).resolves.toMatchObject({ sent: false });
  });

  test('a landline or a blank number is not texted', async () => {
    await expect(sendSmsSafely('(043) 288-1234', 'Test')).resolves.toEqual({ sent: false, skipped: 'no_mobile_number' });
    await expect(sendSmsSafely('', 'Test')).resolves.toEqual({ sent: false, skipped: 'no_mobile_number' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('loan reminders are queued only for members with a mobile number', async () => {
    answer(db.module.query, [['FROM users u LEFT JOIN members m', { rows: [{ id: 7, phone: '0917 123 4567' }, { id: 8, phone: '' }] }]]);
    const queued = await queueSmsForUsers([{ user_id: 7, message: 'Loan due soon.' }, { user_id: 8, message: 'Loan due soon.' }], (row) => row.message);
    expect(queued).toBe(1);
    expect(db.module.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sms_outbox'), [[7], ['+639171234567'], ['Loan due soon.']]);
  });

  test('edge case: an empty list queues nothing and asks the database nothing', async () => {
    await expect(queueSmsForUsers([], () => 'x')).resolves.toBe(0);
    expect(db.module.query).not.toHaveBeenCalled();
  });
});
