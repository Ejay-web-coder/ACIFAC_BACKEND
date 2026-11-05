import express from 'express';
import { requireAdmin, requireAuth, requireAdminOrVendor } from '../middleware/auth.js';
import {
  createInventoryItem,
  createKadiwaBranch,
  createKadiwaSale,
  deleteInventoryItem,
  getKadiwaAnalytics,
  listKadiwaBranches,
  listKadiwaData,
  listKadiwaSales,
  restockInventoryItem,
  transferInventoryItem,
  reviewKadiwaSale,
  reviewKadiwaSales,
  searchKadiwaMembers,
  updateInventoryItem,
  updateKadiwaBranch,
} from '../controllers/kadiwaController.js';

const router = express.Router();

// Members for the New Sale's member purchases (patronage points), by member ID
// or name: the office's form and the Kadiwa vendor's.
router.get('/members', requireAuth, requireAdminOrVendor, searchKadiwaMembers);

router.use(requireAuth, requireAdmin);
router.get('/', listKadiwaData);
// The store's branches: each with its own stock and sales.
router.get('/branches', listKadiwaBranches);
router.post('/branches', createKadiwaBranch);
router.patch('/branches/:id', updateKadiwaBranch);
router.get('/sales', listKadiwaSales);
// The Kadiwa chart and products of one branch or all.
router.get('/analytics', getKadiwaAnalytics);
router.post('/sales', createKadiwaSale);
// A vendor's sale: confirmed (then counted) or rejected with the reason.
router.post('/sales/:id/review', reviewKadiwaSale);
// A vendor's report for a day sent in several parts, reviewed together.
router.post('/sales/review', reviewKadiwaSales);
router.post('/inventory', createInventoryItem);
router.patch('/inventory/:id', updateInventoryItem);
router.delete('/inventory/:id', deleteInventoryItem);
router.patch('/inventory/:id/restock', restockInventoryItem);
// Stock sent from one branch (the main store) to another.
router.post('/inventory/:id/transfer', transferInventoryItem);

export default router;
