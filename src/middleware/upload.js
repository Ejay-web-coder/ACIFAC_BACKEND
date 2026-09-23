import multer from 'multer';

// Files are kept in memory only long enough to validate them and hand them to
// the storage service (Supabase Storage in production). Nothing is written to
// the server's ephemeral disk.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

function memoryUpload(maxBytes, allowed) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 2, fields: 80 },
    fileFilter: (_req, file, callback) => {
      if (!allowed.includes(file.mimetype)) return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      return callback(null, true);
    },
  });
}

export const memberDocumentUpload = memoryUpload(5 * 1024 * 1024, DOCUMENT_TYPES);
export const ocrDocumentUpload = memoryUpload(10 * 1024 * 1024, DOCUMENT_TYPES);
export const legalDocumentUpload = memoryUpload(10 * 1024 * 1024, DOCUMENT_TYPES);
