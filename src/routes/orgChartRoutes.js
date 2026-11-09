import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { profilePhotoUpload } from '../middleware/upload.js';
import { deleteOrgChartPhoto, getOrgChart, getOrgChartPhoto, updateOrgChart, uploadOrgChartPhoto } from '../controllers/orgChartController.js';

// The organizational chart: read by everyone signed in, changed by administrators.
const router = express.Router();
router.get('/', requireAuth, getOrgChart);
router.put('/', requireAuth, requireAdmin, updateOrgChart);
// Each position's 2x2 picture.
router.get('/:id/photo', requireAuth, getOrgChartPhoto);
router.post('/:id/photo', requireAuth, requireAdmin, profilePhotoUpload.single('photo'), uploadOrgChartPhoto);
router.delete('/:id/photo', requireAuth, requireAdmin, deleteOrgChartPhoto);

export default router;
