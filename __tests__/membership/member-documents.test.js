import { describe, test, expect } from '@jest/globals';
import { assertValidUpload, safeOriginalName } from '../../src/services/storage.js';
import { IMAGE_TYPES, MEMBER_FILE_TYPES } from '../../src/middleware/upload.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj');
const file = (mimetype, buffer) => ({ originalname: 'upload', mimetype, buffer, size: buffer.length });

describe('Member documents (assertValidUpload, safeOriginalName)', () => {
  test('accepts a real JPEG photo and a real PDF scan', () => {
    expect(() => assertValidUpload(file('image/jpeg', JPEG), IMAGE_TYPES, '2x2 picture')).not.toThrow();
    expect(() => assertValidUpload(file('application/pdf', PDF), MEMBER_FILE_TYPES, 'ID document')).not.toThrow();
  });

  test('rejects a file whose content does not match its type (a renamed text file)', () => {
    expect(() => assertValidUpload(file('image/jpeg', Buffer.from('just some text')), IMAGE_TYPES, 'signature'))
      .toThrow('The signature must be a valid JPG, PNG, WEBP file.');
  });

  test('rejects a file type that is not allowed for that upload', () => {
    expect(() => assertValidUpload(file('application/pdf', PDF), IMAGE_TYPES, 'profile photo'))
      .toThrow('The profile photo must be a valid JPG, PNG, WEBP file.');
  });

  test('an empty or missing file asks for the upload, with the right article', () => {
    expect(() => assertValidUpload(file('image/jpeg', Buffer.alloc(0)), MEMBER_FILE_TYPES, 'ID document')).toThrow('Please upload an ID document.');
    expect(() => assertValidUpload(undefined, MEMBER_FILE_TYPES, 'RSBSA enrollment copy')).toThrow('Please upload an RSBSA enrollment copy.');
    expect(() => assertValidUpload(null, IMAGE_TYPES, 'signature')).toThrow('Please upload a signature.');
  });

  test('file names are made safe to store and show', () => {
    expect(safeOriginalName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeOriginalName('Juan <ID>.jpg')).toBe('Juan _ID_.jpg');
    expect(safeOriginalName('')).toBe('document');
  });
});
