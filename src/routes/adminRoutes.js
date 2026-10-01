import express from 'express';
import { createMemberAccount, getAccount, listAccounts, listAuditLogs, listMembersWithoutAccounts, resetMemberPassword, sendEmailTest, updateAccountStatus } from '../controllers/adminController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { downloadLoanId, downloadLoanRequestId, getLoan, listLoanRequests, listLoans, listPayments, recordPayment, reviewLoanRequest } from '../controllers/loanController.js';
import { createLoanWithIds } from '../controllers/loanIdController.js';
import { loanApplicationUpload } from '../middleware/upload.js';
import { getAnalytics, getDashboard } from '../controllers/analyticsController.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/dashboard', getDashboard);
router.get('/members/available', listMembersWithoutAccounts);
router.get('/accounts', listAccounts);
router.get('/accounts/:id', getAccount);
router.post('/accounts', createMemberAccount);
router.patch('/accounts/:id/status', updateAccountStatus);
router.post('/accounts/:id/reset-password', resetMemberPassword);
router.get('/audit-logs', listAuditLogs);
router.post('/email-test', sendEmailTest);
router.get('/analytics', getAnalytics);
router.get('/loans', listLoans);
// A new loan comes with the borrower's and the co-maker's valid IDs.
router.post('/loans', loanApplicationUpload, createLoanWithIds);
router.get('/loans/:id', getLoan);
router.get('/loans/:id/id-documents/:holder', downloadLoanId);
router.post('/loans/:id/payments', recordPayment);
router.get('/loan-payments', listPayments);
router.get('/loan-requests', listLoanRequests);
router.patch('/loan-requests/:id', reviewLoanRequest);
router.get('/loan-requests/:id/id-documents/:holder', downloadLoanRequestId);

export default router;
