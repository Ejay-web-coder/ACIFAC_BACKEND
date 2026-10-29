import express from 'express';
import { requireAuth, requireVendor } from '../middleware/auth.js';
import { createVendorKadiwaSale, listVendorKadiwa } from '../controllers/kadiwaController.js';

// Kadiwa store vendors: the day's sales and expenses, sent for review.
const router = express.Router();

router.use(requireAuth, requireVendor);
router.get('/kadiwa', listVendorKadiwa);
router.post('/kadiwa/sales', createVendorKadiwaSale);

export default router;
