import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

const uploadDirectory = path.resolve(process.env.MEMBER_DOCUMENT_DIR || 'private/member-documents');
const allowedTypesByField = {
  idDocument: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  profilePhoto: new Set(['image/jpeg', 'image/png', 'image/webp']),
};

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    fs.mkdir(uploadDirectory, { recursive: true }, (error) => callback(error, uploadDirectory));
  },
  filename: (_req, file, callback) => {
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

export const memberDocumentUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = allowedTypesByField[file.fieldname] || allowedTypesByField.idDocument;
    if (!allowed.has(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname || 'file'));
    }
    return callback(null, true);
  },
});
