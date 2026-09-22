import express from 'express';
import { analyzeDocument, listDocuments, reviewDocument } from '../controllers/ocrController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { ocrDocumentUpload } from '../middleware/ocrUpload.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/', listDocuments);
router.post('/analyze', ocrDocumentUpload.single('document'), analyzeDocument);
router.patch('/:id/review', reviewDocument);

export default router;