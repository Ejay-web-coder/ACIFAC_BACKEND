import multer from 'multer';

// Files are kept in memory only long enough to validate them and hand them to
// the storage service (Supabase Storage in production). Nothing is written to
// the server's ephemeral disk.
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// Add Member's RSBSA copy and valid ID may also be a Word document.
export const MEMBER_FILE_TYPES = [...DOCUMENT_TYPES, DOCX_TYPE];

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

// Add Member: the signed ID copy, the 2x2 photo, the RSBSA enrollment copy (still accepting the
// specimen signatures that were drawn on screen before the copy was required).
export const memberDocumentUpload = memoryUpload(5 * 1024 * 1024, DOCUMENT_TYPES, 6);
// Add Member and Edit Member's files: the same, plus .docx for the RSBSA copy and the valid ID
// (each controller checks which types each file may be).
export const memberFileUpload = memoryUpload(5 * 1024 * 1024, MEMBER_FILE_TYPES, 6);
// A loan application: the borrower's and the co-maker's valid IDs and the borrower's signature.
export const loanApplicationUpload = memberDocumentUpload.fields([{ name: 'borrowerId', maxCount: 1 }, { name: 'coMakerId', maxCount: 1 }, { name: 'borrowerSignature', maxCount: 1 }]);
export const ocrDocumentUpload = memoryUpload(10 * 1024 * 1024, DOCUMENT_TYPES);
export const legalDocumentUpload = memoryUpload(10 * 1024 * 1024, DOCUMENT_TYPES);
// Pictures are resized in the browser to about 100 KB; 5 MB leaves room for originals.
export const profilePhotoUpload = memoryUpload(5 * 1024 * 1024, IMAGE_TYPES);
