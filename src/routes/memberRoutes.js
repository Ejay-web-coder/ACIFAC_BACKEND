import express from 'express';
import {
  addShareContribution,
  archiveMember,
  createMember,
  createSavingsRecord,
  importMembers,
  downloadMemberDocument,
  getMember,
  getMemberStatistics,
  getMyMemberData,
  listArchivedMembers,
  listMembers,
  listSavingsRecords,
  restoreMember,
  updateMember,
} from '../controllers/memberController.js';
import { createMemberLoanRequest } from '../controllers/loanController.js';
import { requireAdmin, requireAuth, requireMember } from '../middleware/auth.js';
import { memberDocumentUpload } from '../middleware/upload.js';

const router = express.Router();

router.use(requireAuth);

// Member self-service: always scoped to the signed-in member's own record.
router.get('/me', requireMember, getMyMemberData);
router.post('/me/loan-requests', requireMember, createMemberLoanRequest);
router.get('/me/documents/:kind', requireMember, downloadMemberDocument);

// Everything below is admin-only: member lists expose personal data.
router.use(requireAdmin);
router.get('/', listMembers);
router.get('/statistics', getMemberStatistics);
router.get('/archived', listArchivedMembers);
router.get('/savings', listSavingsRecords);
router.post('/savings', createSavingsRecord);
router.post('/import', importMembers);
router.post('/', memberDocumentUpload.fields([
  { name: 'idDocument', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
]), createMember);
router.get('/:id', getMember);
router.get('/:id/documents/:kind', downloadMemberDocument);
router.post('/:id/share-contributions', addShareContribution);
router.put('/:id', updateMember);
router.patch('/:id/archive', archiveMember);
router.patch('/:id/restore', restoreMember);

export default router;
