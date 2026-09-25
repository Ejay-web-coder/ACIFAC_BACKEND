import express from 'express';
import {
  analyzeDocument, downloadDocument, listDocuments, listFormDefinitions, postReviewedDocument, retryDocument, reverifyDocument, reviewDocument,
} from '../controllers/ocrController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { ocrDocumentUpload } from '../middleware/upload.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/', listDocuments);
router.get('/forms', listFormDefinitions);
router.post('/analyze', ocrDocumentUpload.single('document'), analyzeDocument);
router.get('/:id/file', downloadDocument);
router.patch('/:id/review', reviewDocument);
router.post('/:id/verify', reverifyDocument);
router.post('/:id/retry', retryDocument);
router.post('/:id/post', postReviewedDocument);

export default router;
