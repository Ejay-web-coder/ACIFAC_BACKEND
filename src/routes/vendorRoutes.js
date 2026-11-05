import express from 'express';
import { requireAuth, requireVendor } from '../middleware/auth.js';
import { createVendorKadiwaSale, getVendorKadiwaAnalytics, listVendorKadiwa, listVendorSales } from '../controllers/kadiwaController.js';
import { getVendorActivity } from '../controllers/vendorActivityController.js';

// Kadiwa store vendors: the day's sales and expenses, sent for review.
const router = express.Router();

router.use(requireAuth, requireVendor);
router.get('/kadiwa', listVendorKadiwa);
router.post('/kadiwa/sales', createVendorKadiwaSale);
// The vendor's branch: its sales, expenses and net income, and its products.
router.get('/kadiwa/analytics', getVendorKadiwaAnalytics);
// The vendor's sales history (confirmed, waiting, rejected) and activity log.
router.get('/kadiwa/sales', listVendorSales);
router.get('/activity', getVendorActivity);

export default router;
