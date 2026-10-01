import express from 'express';
import { getLoanPolicy, quoteLoan } from '../controllers/loanController.js';
import { previewLoanIdChecks, readLoanId } from '../controllers/loanIdController.js';
import { requireAuth } from '../middleware/auth.js';
import { memberDocumentUpload } from '../middleware/upload.js';

const router = express.Router();

router.use(requireAuth);
router.get('/policy', getLoanPolicy);
router.post('/quote', quoteLoan);
// The application form's valid IDs: AI reads each one as it is picked, then the
// form shows how they compare with the borrower and co-maker.
router.post('/id-reading', memberDocumentUpload.single('idDocument'), readLoanId);
router.post('/id-checks', previewLoanIdChecks);

export default router;
