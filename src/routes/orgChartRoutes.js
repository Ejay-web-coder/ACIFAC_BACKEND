import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { getOrgChart, updateOrgChart } from '../controllers/orgChartController.js';

// The organizational chart: read by everyone signed in, changed by administrators.
const router = express.Router();
router.get('/', requireAuth, getOrgChart);
router.put('/', requireAuth, requireAdmin, updateOrgChart);

export default router;
