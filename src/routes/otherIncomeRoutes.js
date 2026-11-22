import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { createOtherIncome, deleteOtherIncome, listOtherIncome } from '../controllers/otherIncomeController.js';

// Other income of the cooperative (donations, grants, bank interest, ...): the office's only.
export const otherIncomeRoutes = express.Router()
  .use(requireAuth, requireAdmin)
  .get('/', listOtherIncome)
  .post('/', createOtherIncome)
  .delete('/:id', deleteOtherIncome);
