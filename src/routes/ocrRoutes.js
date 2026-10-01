import express from 'express';
import {
  analyzeDocument, attachCoMakerId, attachIdDocument, attachPhoto, downloadCoMakerId, downloadDocument, downloadIdDocument, downloadPhoto, listDocuments, listFormDefinitions,
  postReviewedDocument, retryDocument, reverifyDocument, reviewDocument,
} from '../controllers/ocrController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { memberDocumentUpload, ocrDocumentUpload, profilePhotoUpload } from '../middleware/upload.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/', listDocuments);
router.get('/forms', listFormDefinitions);
router.post('/analyze', ocrDocumentUpload.single('document'), analyzeDocument);
router.get('/:id/file', downloadDocument);
// The valid ID of a scanned membership form's applicant or loan form's borrower (5 MB, like Add Member).
router.post('/:id/id-document', memberDocumentUpload.single('idDocument'), attachIdDocument);
router.get('/:id/id-document', downloadIdDocument);
// The co-maker's valid ID for a scanned loan form.
router.post('/:id/co-maker-id', memberDocumentUpload.single('idDocument'), attachCoMakerId);
router.get('/:id/co-maker-id', downloadCoMakerId);
// The applicant's 2x2 picture when the one on the form cannot be recognised.
router.post('/:id/photo', profilePhotoUpload.single('photo'), attachPhoto);
router.get('/:id/photo', downloadPhoto);
router.patch('/:id/review', reviewDocument);
router.post('/:id/verify', reverifyDocument);
router.post('/:id/retry', retryDocument);
router.post('/:id/post', postReviewedDocument);

export default router;
