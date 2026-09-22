import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { createRentalRequest, listMachineryData, reviewRentalRequest } from '../controllers/machineryController.js';

const router = express.Router();

router.use(requireAuth);
router.get('/', requireAdmin, listMachineryData);
router.post('/requests', createRentalRequest);
router.patch('/requests/:id', requireAdmin, reviewRentalRequest);

export default router;