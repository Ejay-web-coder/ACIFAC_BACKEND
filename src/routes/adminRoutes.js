import express from 'express';
import { listMembersWithoutAccounts, listAccounts, getAccount, createMemberAccount, updateAccountStatus, resetMemberPassword, listAuditLogs, sendEmailTest } from '../controllers/adminController.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { listLoansData, createLoan, reviewLoanRequest, recordPayment } from '../controllers/loanController.js';
import { getAnalytics } from '../controllers/analyticsController.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/members/available', listMembersWithoutAccounts);
router.get('/accounts', listAccounts);
router.get('/accounts/:id', getAccount);
router.post('/accounts', createMemberAccount);
router.patch('/accounts/:id/status', updateAccountStatus);
router.post('/accounts/:id/reset-password', resetMemberPassword);
router.get('/audit-logs', listAuditLogs);
router.post('/email-test', sendEmailTest);
router.get('/analytics', getAnalytics);
router.get('/loans', listLoansData);
router.post('/loans', createLoan);
router.post('/loans/:id/payments', recordPayment);
router.patch('/loan-requests/:id', reviewLoanRequest);

export default router;
