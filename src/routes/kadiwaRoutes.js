import express from 'express';
import { requireAdmin, requireAuth, requireAdminOrVendor } from '../middleware/auth.js';
import {
  createInventoryItem,
  createKadiwaSale,
  deleteInventoryItem,
  listKadiwaData,
  listKadiwaSales,
  restockInventoryItem,
  reviewKadiwaSale,
  reviewKadiwaSales,
  searchKadiwaMembers,
  updateInventoryItem,
} from '../controllers/kadiwaController.js';

const router = express.Router();

// Members for the New Sale's member purchases (patronage points), by member ID
// or name: the office's form and the Kadiwa vendor's.
router.get('/members', requireAuth, requireAdminOrVendor, searchKadiwaMembers);

router.use(requireAuth, requireAdmin);
router.get('/', listKadiwaData);
router.get('/sales', listKadiwaSales);
router.post('/sales', createKadiwaSale);
// A vendor's sale: confirmed (then counted) or rejected with the reason.
router.post('/sales/:id/review', reviewKadiwaSale);
// A vendor's report for a day sent in several parts, reviewed together.
router.post('/sales/review', reviewKadiwaSales);
router.post('/inventory', createInventoryItem);
router.patch('/inventory/:id', updateInventoryItem);
router.delete('/inventory/:id', deleteInventoryItem);
router.patch('/inventory/:id/restock', restockInventoryItem);

export default router;
