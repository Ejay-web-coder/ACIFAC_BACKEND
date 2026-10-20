import express from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import {
  createMachinery, createRentalRequest, getDayRental, listDayRentals, listMachineryCatalog, listMachineryData, receiveRentalPayment, reviewRentalRequest,
  updateMachinery, updateOperationStatus, voidRentalPayment,
} from '../controllers/machineryController.js';
import {
  createExpense, createRate, createService, deleteExpense, deleteRate, deleteService, getReportForm, getService, listExpenses, listPeriodBalances, listRates,
  listServices, philmechReport, quoteService, receivePayment, savePeriodBalance, saveReportForm, updateExpense, updateRate, updateService, voidPayment,
} from '../controllers/machineryServiceController.js';

const router = express.Router();

router.use(requireAuth);
router.get('/catalog', listMachineryCatalog);
router.post('/requests', createRentalRequest);
router.get('/', requireAdmin, listMachineryData);
router.post('/', requireAdmin, createMachinery);
router.patch('/requests/:id', requireAdmin, reviewRentalRequest);
router.patch('/operations/:id', requireAdmin, updateOperationStatus);
// Bookings of the machines rented by the day and their payments (Day Rentals tab).
router.get('/day-rentals', requireAdmin, listDayRentals);
router.get('/day-rentals/:id', requireAdmin, getDayRental);
router.post('/day-rentals/:id/payments', requireAdmin, receiveRentalPayment);
router.delete('/day-rentals/:id/payments/:paymentId', requireAdmin, voidRentalPayment);

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
router.get('/reports/philmech/form', requireAdmin, getReportForm);
router.put('/reports/philmech/form', requireAdmin, saveReportForm);
router.patch('/rates/:rateId', requireAdmin, updateRate);
router.delete('/rates/:rateId', requireAdmin, deleteRate);
router.get('/:id/rates', requireAdmin, listRates);
router.post('/:id/rates', requireAdmin, createRate);

router.patch('/:id', requireAdmin, updateMachinery);

export default router;
