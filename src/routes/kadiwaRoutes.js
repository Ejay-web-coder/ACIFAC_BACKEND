import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import {
  createInventoryItem,
  createKadiwaSale,
  listKadiwaData,
  restockInventoryItem,
} from '../controllers/kadiwaController.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);
router.get('/', listKadiwaData);
router.post('/sales', createKadiwaSale);
router.post('/inventory', createInventoryItem);
router.patch('/inventory/:id/restock', restockInventoryItem);

export default router;
