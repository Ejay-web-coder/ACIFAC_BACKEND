import express from 'express';
import { getLoanPolicy, quoteLoan } from '../controllers/loanController.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);
router.get('/policy', getLoanPolicy);
router.post('/quote', quoteLoan);

export default router;
