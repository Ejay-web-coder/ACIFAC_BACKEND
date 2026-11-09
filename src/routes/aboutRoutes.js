import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { getAbout, updateAbout } from '../controllers/aboutController.js';

// The About page's Mission & Vision: read by everyone signed in, changed by administrators.
const router = express.Router();
router.get('/', requireAuth, getAbout);
router.put('/', requireAuth, requireAdmin, updateAbout);

export default router;
