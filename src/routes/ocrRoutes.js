import express from 'express';
import { analyzeDocument, downloadDocument, listDocuments, reviewDocument } from '../controllers/ocrController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { ocrDocumentUpload } from '../middleware/upload.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/', listDocuments);
router.post('/analyze', ocrDocumentUpload.single('document'), analyzeDocument);
router.get('/:id/file', downloadDocument);
router.patch('/:id/review', reviewDocument);

export default router;
