import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { answer, mockDatabase, mockRequest, mockResponse } from '../helpers/http.js';
import { ADMIN } from '../helpers/members.js';

// The database, file storage and the AI service are mocked: the AI reads the
// document in one test and fails in another.
const db = mockDatabase();
jest.unstable_mockModule('../../src/config/db.js', () => db.module);
const storage = {
  BUCKETS: { memberDocuments: 'member-documents', memberPhotos: 'member-photos', ocrUploads: 'ocr-uploads', legalDocuments: 'legal-documents' },
  storageDriver: 'local', assertValidUpload: jest.fn(), safeOriginalName: jest.fn((name) => name), uploadFile: jest.fn(async () => 'local://ocr-uploads/scan.jpg'),
  downloadFile: jest.fn(), createSignedUrl: jest.fn(), removeFile: jest.fn(async () => {}), sendStoredFile: jest.fn(),
};
jest.unstable_mockModule('../../src/services/storage.js', () => storage);
class AiUnavailableError extends Error {}
const ai = { AiUnavailableError, askAi: jest.fn(), askAiText: jest.fn(), resetAiModelStateForTesting: jest.fn(), aiFailureReason: jest.fn(() => 'the AI service is busy.') };
jest.unstable_mockModule('../../src/services/aiClient.js', () => ai);
const { analyzeDocument } = await import('../../src/controllers/ocrController.js');
const { UNRECOGNIZED } = await import('../../src/services/documentRouting.js');

let saved;
function databaseHas({ existing = null } = {}) {
  answer(db.module.query, [
    ['WHERE file_sha256 = $1', { rows: existing ? [existing] : [] }],
    ['UPDATE document_scans SET verification', (params) => ({ rows: [{ ...saved, verification: JSON.parse(params[0]) }] })],
  ]);
  answer(db.client.query, [['INSERT INTO document_scans', (v) => {
    saved = { id: 61, original_file_name: v[0], stored_file_path: v[1], detected_document_type: v[5], ai_confidence: v[6], extracted_data: JSON.parse(v[8]), processing_status: v[9], processing_error: v[10], capture_source: v[11], authenticity: JSON.parse(v[12]), retry_count: v[14], next_retry_at: v[15], cross_check: JSON.parse(v[16]), review_status: 'needs_review' };
    return { rows: [saved] };
  }]]);
}
// The AI's two readings: the first (full analysis) and the second (fields only).
function aiReads(firstReading, secondReading = firstReading) {
  ai.askAi.mockImplementation(async (file, prompt, instruction) => (instruction.startsWith('Read this document') ? firstReading : secondReading));
}
const upload = () => mockRequest({ method: 'POST', body: { source: 'upload' }, user: ADMIN });
const withFile = (req) => Object.assign(req, { file: { originalname: 'receipt.jpg', mimetype: 'image/jpeg', size: 4, buffer: Buffer.from([0xff, 0xd8, 0xff, 0x01]) } });
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {}); databaseHas(); });

describe('Scanning a document (ocrController.analyzeDocument)', () => {
  test('a document the AI reads clearly is saved with its type and fields', async () => {
    aiReads({ documentType: 'Payment Receipt', confidence: 95, ocrText: 'OFFICIAL RECEIPT 1024', extractedData: { 'Receipt No': '1024' }, authenticity: { verdict: 'genuine', score: 90 } });
    const res = mockResponse();
    await analyzeDocument(withFile(upload()), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Document processed.', data: { id: 61, documentType: 'Payment Receipt', processingStatus: 'completed', postable: false } });
  });

  test('a reading the AI is unsure of (confidence under 70) is not trusted', async () => {
    aiReads({ documentType: 'Loan Form', confidence: 40, extractedData: {} }, { documentType: 'Membership Form', extractedData: {} });
    const res = mockResponse();
    await analyzeDocument(withFile(upload()), res);
    expect(res.body.data.documentType).toBe(UNRECOGNIZED);
  });

  test('when the AI fails, the scan is kept and read again automatically', async () => {
    ai.askAi.mockRejectedValue(new Error('429 Too Many Requests'));
    const res = mockResponse();
    await analyzeDocument(withFile(upload()), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/^The document was saved but could not be read yet: the AI service is busy\. It will be read again automatically in about 1[45] seconds\.$/);
    expect(res.body.data).toMatchObject({ processingStatus: 'failed', retry: { count: 1 } });
  });

  test('when the AI refuses the file itself, it waits for Retry instead', async () => {
    ai.askAi.mockRejectedValue(Object.assign(new Error('The file could not be processed'), { retryable: false }));
    const res = mockResponse();
    await analyzeDocument(withFile(upload()), res);
    expect(res.body.message).toMatch(/Press Retry to read it again\.$/);
    expect(res.body.data.retry.nextAt).toBeNull();
  });

  test('edge case: the same document cannot be uploaded twice', async () => {
    databaseHas({ existing: { id: 3, processing_status: 'completed', stored_file_path: 'local://ocr-uploads/old.jpg' } });
    await expect(analyzeDocument(withFile(upload()), mockResponse())).rejects.toMatchObject({ status: 409, message: 'This document has already been uploaded.' });
    expect(ai.askAi).not.toHaveBeenCalled();
  });
});
