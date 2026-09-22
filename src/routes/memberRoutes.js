import express from 'express';
import {
  createMember,
  archiveMember,
  addShareContribution,
  getMember,
  getMyMemberData,
  getMemberStatistics,
  listSavingsRecords,
  listArchivedMembers,
  listMembers,
  restoreMember,
  updateMember,
} from '../controllers/memberController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { memberDocumentUpload } from '../middleware/memberUpload.js';
import { createMemberLoanRequest } from '../controllers/loanController.js';

const router = express.Router();

router.use(requireAuth);
router.get('/', listMembers);
router.get('/statistics', getMemberStatistics);
router.get('/archived', listArchivedMembers);
router.get('/savings', requireAdmin, listSavingsRecords);
router.get('/me', getMyMemberData);
router.post('/me/loan-requests', createMemberLoanRequest);
router.get('/:id', requireAdmin, getMember);
router.post('/:id/share-contributions', requireAdmin, addShareContribution);
router.post('/', requireAdmin, memberDocumentUpload.fields([
  { name: 'idDocument', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
]), createMember);
router.put('/:id', requireAdmin, updateMember);
router.patch('/:id/archive', requireAdmin, archiveMember);
router.patch('/:id/restore', requireAdmin, restoreMember);

export default router;
