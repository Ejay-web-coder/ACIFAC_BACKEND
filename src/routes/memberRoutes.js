import express from 'express';
import {
  addShareContribution,
  archiveMember,
  createMember,
  createSavingsRecord,
  createSavingsWithdrawal,
  importMembers,
  downloadMemberDocument,
  getMember,
  getMemberSavings,
  getMemberStatistics,
  getMyMemberData,
  listArchivedMembers,
  listMembers,
  listSavingsMembers,
  listSavingsRecords,
  replaceMemberDocuments,
  restoreMember,
  updateMember,
} from '../controllers/memberController.js';
import { createMemberLoanRequestWithIds } from '../controllers/loanIdController.js';
import { getMyActivity } from '../controllers/memberActivityController.js';
import { requireAdmin, requireAuth, requireMember } from '../middleware/auth.js';
import { loanApplicationUpload, memberDocumentUpload } from '../middleware/upload.js';

const router = express.Router();

router.use(requireAuth);

// Member self-service: always scoped to the signed-in member's own record.
router.get('/me', requireMember, getMyMemberData);
// An application comes with the borrower's and the co-maker's valid IDs.
router.post('/me/loan-requests', requireMember, loanApplicationUpload, createMemberLoanRequestWithIds);
router.get('/me/documents/:kind', requireMember, downloadMemberDocument);
router.get('/me/activity', requireMember, getMyActivity);

// Everything below is admin-only: member lists expose personal data.
router.use(requireAdmin);
router.get('/', listMembers);
router.get('/statistics', getMemberStatistics);
router.get('/archived', listArchivedMembers);
router.get('/savings', listSavingsRecords);
router.post('/savings', createSavingsRecord);
router.post('/savings/withdrawals', createSavingsWithdrawal);
router.get('/savings/members', listSavingsMembers);
router.post('/import', importMembers);
router.post('/', memberDocumentUpload.fields([
  { name: 'idDocument', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'signatures', maxCount: 3 },
]), createMember);
router.get('/:id', getMember);
router.get('/:id/savings', getMemberSavings);
router.get('/:id/documents/:kind', downloadMemberDocument);
router.post('/:id/documents', memberDocumentUpload.fields([
  { name: 'idDocument', maxCount: 1 },
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'signature1', maxCount: 1 },
  { name: 'signature2', maxCount: 1 },
  { name: 'signature3', maxCount: 1 },
]), replaceMemberDocuments);
router.post('/:id/share-contributions', addShareContribution);
router.put('/:id', updateMember);
router.patch('/:id/archive', archiveMember);
router.patch('/:id/restore', restoreMember);

export default router;
