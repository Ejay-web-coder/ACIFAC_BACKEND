import express from 'express';
import {
  analyzeDocument, attachCoMakerId, deleteScan, attachIdDocument, attachPhoto, downloadCoMakerId, downloadDocument, downloadIdDocument, downloadPhoto, listDocuments, listFormDefinitions,
  postReviewedDocument, rejectFlagged, retryDocument, retryDue, reverifyDocument, reviewDocument, undoAutoPost,
} from '../controllers/ocrController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { memberDocumentUpload, ocrDocumentUpload, profilePhotoUpload } from '../middleware/upload.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/', listDocuments);
router.get('/forms', listFormDefinitions);
router.post('/analyze', ocrDocumentUpload.single('document'), analyzeDocument);
// Reads again the next queued scan the AI could not read (called by the open OCR Scanner page).
router.post('/retry-due', retryDue);
// Rejects every flagged scan at once (failed checks or not read, not queued).
router.post('/reject-flagged', rejectFlagged);
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
// Deletes a scan that was never saved to records, with its files.
router.delete('/:id', deleteScan);
// Takes back a form saved automatically, within 48 hours.
router.post('/:id/undo', undoAutoPost);

export default router;
