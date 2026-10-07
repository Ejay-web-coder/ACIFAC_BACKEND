import multer from 'multer';

// Files are kept in memory only long enough to validate them and hand them to
// the storage service (Supabase Storage in production). Nothing is written to
// the server's ephemeral disk.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

function memoryUpload(maxBytes, allowed, maxFiles = 2) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: maxFiles, fields: 80 },
    fileFilter: (_req, file, callback) => {
      if (!allowed.includes(file.mimetype)) return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
      return callback(null, true);
    },
  });
}

// Add Member: the signed ID copy and the 2x2 photo (still accepting the
// specimen signatures that were drawn on screen before the copy was required).
export const memberDocumentUpload = memoryUpload(5 * 1024 * 1024, DOCUMENT_TYPES, 5);
// A loan application: the borrower's and the co-maker's valid IDs and the borrower's signature.
export const loanApplicationUpload = memberDocumentUpload.fields([{ name: 'borrowerId', maxCount: 1 }, { name: 'coMakerId', maxCount: 1 }, { name: 'borrowerSignature', maxCount: 1 }]);
export const ocrDocumentUpload = memoryUpload(10 * 1024 * 1024, DOCUMENT_TYPES);
export const legalDocumentUpload = memoryUpload(10 * 1024 * 1024, DOCUMENT_TYPES);
// Pictures are resized in the browser to about 100 KB; 5 MB leaves room for originals.
export const profilePhotoUpload = memoryUpload(5 * 1024 * 1024, IMAGE_TYPES);
