import express from 'express';
import {
  analyzeDocument, attachIdDocument, attachPhoto, downloadDocument, downloadIdDocument, downloadPhoto, listDocuments, listFormDefinitions, postReviewedDocument, retryDocument, reverifyDocument, reviewDocument,
} from '../controllers/ocrController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { memberDocumentUpload, ocrDocumentUpload, profilePhotoUpload } from '../middleware/upload.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/', listDocuments);
router.get('/forms', listFormDefinitions);
router.post('/analyze', ocrDocumentUpload.single('document'), analyzeDocument);
router.get('/:id/file', downloadDocument);
// The applicant's valid ID for a scanned membership form (5 MB, like Add Member).
router.post('/:id/id-document', memberDocumentUpload.single('idDocument'), attachIdDocument);
router.get('/:id/id-document', downloadIdDocument);
// The applicant's 2x2 picture when the one on the form cannot be recognised.
router.post('/:id/photo', profilePhotoUpload.single('photo'), attachPhoto);
router.get('/:id/photo', downloadPhoto);
router.patch('/:id/review', reviewDocument);
router.post('/:id/verify', reverifyDocument);
router.post('/:id/retry', retryDocument);
router.post('/:id/post', postReviewedDocument);

export default router;
