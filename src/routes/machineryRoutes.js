import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import {
  createMachinery, createRentalRequest, listMachineryCatalog, listMachineryData, reviewRentalRequest, updateMachinery, updateOperationStatus,
} from '../controllers/machineryController.js';
import {
  createExpense, createRate, createService, deleteExpense, deleteRate, deleteService, getService, listExpenses, listPeriodBalances, listRates,
  listServices, philmechReport, quoteService, receivePayment, savePeriodBalance, updateExpense, updateRate, updateService, voidPayment,
} from '../controllers/machineryServiceController.js';

const router = express.Router();

router.use(requireAuth);
router.get('/catalog', listMachineryCatalog);
router.post('/requests', createRentalRequest);
router.get('/', requireAdmin, listMachineryData);
router.post('/', requireAdmin, createMachinery);
router.patch('/requests/:id', requireAdmin, reviewRentalRequest);
router.patch('/operations/:id', requireAdmin, updateOperationStatus);

// Per-service jobs, payments, expenses and the PhilMech report (admin only).
router.post('/services/quote', requireAdmin, quoteService);
router.get('/services', requireAdmin, listServices);
router.post('/services', requireAdmin, createService);
router.get('/services/:id', requireAdmin, getService);
router.patch('/services/:id', requireAdmin, updateService);
router.delete('/services/:id', requireAdmin, deleteService);
router.post('/services/:id/payments', requireAdmin, receivePayment);
router.delete('/services/:id/payments/:paymentId', requireAdmin, voidPayment);
router.get('/expenses', requireAdmin, listExpenses);
router.post('/expenses', requireAdmin, createExpense);
router.patch('/expenses/:id', requireAdmin, updateExpense);
router.delete('/expenses/:id', requireAdmin, deleteExpense);
router.get('/period-balances', requireAdmin, listPeriodBalances);
router.put('/period-balances', requireAdmin, savePeriodBalance);
router.get('/reports/philmech', requireAdmin, philmechReport);
router.patch('/rates/:rateId', requireAdmin, updateRate);
router.delete('/rates/:rateId', requireAdmin, deleteRate);
router.get('/:id/rates', requireAdmin, listRates);
router.post('/:id/rates', requireAdmin, createRate);

router.patch('/:id', requireAdmin, updateMachinery);

export default router;
