import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';

// Database, file storage and member emails are mocked.
const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const storage = {
  BUCKETS: { memberDocuments: 'member-documents', memberPhotos: 'member-photos', ocrUploads: 'ocr-uploads', legalDocuments: 'legal-documents' },
  storageDriver: 'local',
  assertValidUpload: jest.fn(),
  safeOriginalName: jest.fn((name) => name),
  uploadFile: jest.fn(),
  downloadFile: jest.fn(),
  createSignedUrl: jest.fn(),
  removeFile: jest.fn(async () => {}),
  sendStoredFile: jest.fn(),
};
jest.unstable_mockModule('../../src/services/storage.js', () => storage);
jest.unstable_mockModule('../../src/services/memberEmails.js', () => ({ emailMember: jest.fn(async () => ({ sent: false })), emailNotifiedUsers: jest.fn() }));
const { createMember } = await import('../../src/controllers/memberController.js');
const { todayDateOnly } = await import('../../src/utils/dates.js');

const year = todayDateOnly().slice(0, 4);
const form = { first_name: 'Juan', last_name: 'Dela Cruz', phone: '09171234567', address: 'Brgy. Bibiclat, Aliaga, Nueva Ecija', membership_date: '2026-01-15', share_capital: '1000' };
// cooperativeCapital: the cooperative's total share capital (PHP 100,000 allows every member, a new one too, up to PHP 10,000).
function databaseHas({ duplicate = null, cooperativeCapital = '100000.00' } = {}) {
  answer(db.client.query, [
    ['SELECT id, member_number FROM members', { rows: duplicate ? [duplicate] : [] }],
    ['SELECT COALESCE(SUM(share_capital), 0) AS total FROM members', { rows: [{ total: cooperativeCapital }] }],
    ['AS next_number', { rows: [{ next_number: 4 }] }],
    ['INSERT INTO members', { rows: [{ id: 55 }] }],
  ]);
  answer(db.module.query, [['FROM members m', { rows: [{ id: '55', member_number: `ACIFAC-${year}-004`, full_name: 'Juan Dela Cruz', share_capital: '1000.00', status: 'active' }] }]]);
}
const register = (body) => mockRequest({ method: 'POST', body, user: { id: 1, username: 'admin', role: 'ADMIN' } });
beforeEach(() => { jest.clearAllMocks(); databaseHas(); });

describe('Add member (memberController.createMember)', () => {
  test('registers a new member with the next ACIFAC membership number', async () => {
    const res = mockResponse();
    await createMember(register(form), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Member created successfully.', data: { id: 55, member_number: `ACIFAC-${year}-004`, share_capital: 1000 } });
    const [, params] = db.client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO members'));
    expect(params[0]).toBe(`ACIFAC-${year}-004`);
  });

  test('records the initial share capital as the member\'s first contribution', async () => {
    await createMember(register(form), mockResponse());
    const [sql, params] = db.client.query.mock.calls.find(([text]) => text.includes('INSERT INTO share_contributions'));
    expect(sql).toContain("'Initial'");
    expect(params).toEqual([55, '1000.00', '2026-01-15', `INITIAL-ACIFAC-${year}-004`, 1]);
  });

  test('rejects a blank form with the list of missing fields', async () => {
    await expect(createMember(register({}), mockResponse())).rejects.toMatchObject({
      status: 400,
      message: 'First name is required.',
      details: expect.arrayContaining(['Last name is required.', 'Phone number is required.', 'Address is required.']),
    });
    expect(db.module.withTransaction).not.toHaveBeenCalled();
  });

  test('refuses a member who is already registered', async () => {
    databaseHas({ duplicate: { id: 12, member_number: 'ACIFAC-2025-012' } });
    await expect(createMember(register(form), mockResponse())).rejects.toMatchObject({
      status: 409,
      message: 'This member appears to be already registered (ACIFAC-2025-012). Check the email, RSBSA number, or name and birth date.',
    });
  });

  test('refuses starting share capital above 10% of the cooperative\'s total', async () => {
    await expect(createMember(register({ ...form, share_capital: '10000.01' }), mockResponse())).rejects.toMatchObject({
      status: 400,
      message: "A member's share capital can't be more than 10% of the cooperative's total share capital (PHP 100,000.00). A new member can start with at most PHP 10,000.00.",
    });
  });

  test('uploaded ID and photo are deleted again when the member cannot be saved', async () => {
    databaseHas({ duplicate: { id: 12, member_number: 'ACIFAC-2025-012' } });
    storage.uploadFile.mockResolvedValueOnce('local://member-documents/id.jpg').mockResolvedValueOnce('local://member-photos/photo.jpg');
    const req = register(form);
    req.files = { idDocument: [{ originalname: 'id.jpg', mimetype: 'image/jpeg', buffer: Buffer.from([1]) }], profilePhoto: [{ originalname: 'photo.jpg', mimetype: 'image/jpeg', buffer: Buffer.from([1]) }] };
    await expect(createMember(req, mockResponse())).rejects.toMatchObject({ status: 409 });
    expect(storage.removeFile).toHaveBeenCalledWith('local://member-documents/id.jpg');
    expect(storage.removeFile).toHaveBeenCalledWith('local://member-photos/photo.jpg');
  });
});
