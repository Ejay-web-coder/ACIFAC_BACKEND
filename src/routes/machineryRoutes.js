import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import {
  createMachinery, createRentalRequest, listMachineryCatalog, listMachineryData, reviewRentalRequest, updateMachinery, updateOperationStatus,
} from '../controllers/machineryController.js';

const router = express.Router();

router.use(requireAuth);
router.get('/catalog', listMachineryCatalog);
router.post('/requests', createRentalRequest);
router.get('/', requireAdmin, listMachineryData);
router.post('/', requireAdmin, createMachinery);
router.patch('/requests/:id', requireAdmin, reviewRentalRequest);
router.patch('/operations/:id', requireAdmin, updateOperationStatus);
router.patch('/:id', requireAdmin, updateMachinery);

export default router;
