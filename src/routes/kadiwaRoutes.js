import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import {
  createInventoryItem,
  createKadiwaSale,
  deleteInventoryItem,
  listKadiwaData,
  listKadiwaSales,
  restockInventoryItem,
  updateInventoryItem,
} from '../controllers/kadiwaController.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);
router.get('/', listKadiwaData);
router.get('/sales', listKadiwaSales);
router.post('/sales', createKadiwaSale);
router.post('/inventory', createInventoryItem);
router.patch('/inventory/:id', updateInventoryItem);
router.delete('/inventory/:id', deleteInventoryItem);
router.patch('/inventory/:id/restock', restockInventoryItem);

export default router;
