import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { createPolicy, deletePolicy, listPolicies, updatePolicy } from '../controllers/policyController.js';

// The About page's Policy tab: read by everyone signed in, changed by administrators.
const router = express.Router();
router.get('/', requireAuth, listPolicies);
router.post('/', requireAuth, requireAdmin, createPolicy);
router.put('/:id', requireAuth, requireAdmin, updatePolicy);
router.delete('/:id', requireAuth, requireAdmin, deletePolicy);

export default router;
