import express from 'express';
import { createMemberAccount, getAccount, listAccounts, listAuditLogs, listMembersWithoutAccounts, resetMemberPassword, sendEmailTest, updateAccountStatus } from '../controllers/adminController.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { createLoan, getLoan, listLoanRequests, listLoans, listPayments, recordPayment, reviewLoanRequest } from '../controllers/loanController.js';
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
router.post('/loans', createLoan);
router.get('/loans/:id', getLoan);
router.post('/loans/:id/payments', recordPayment);
router.get('/loan-payments', listPayments);
router.get('/loan-requests', listLoanRequests);
router.patch('/loan-requests/:id', reviewLoanRequest);

export default router;
